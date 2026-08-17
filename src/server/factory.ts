import express from "express";
import type { Express, Request, Response } from "express";
import type { AgentCard, AgentCapabilities } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  DefaultExecutionEventBusManager,
  InMemoryTaskStore,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { jsonRpcHandler, agentCardHandler, restHandler } from "@a2a-js/sdk/server/express";

import {
  Config,
  ErrorFormatterRegistry,
  ObsLoggingMiddleware,
  ErrorHistoryMiddleware,
  ErrorHistory,
  registerSysModules,
} from "apcore-js";

import { SkillMapper } from "../adapters/skill-mapper.js";
import { SchemaConverter } from "../adapters/schema.js";
import { AgentCardBuilder, type Registry } from "../adapters/agent-card.js";
import { PartConverter } from "../adapters/parts.js";
import { ErrorMapper } from "../adapters/errors.js";
import { ApCoreAgentExecutor } from "./executor.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { anonymousContext, identityUserBuilder } from "./context.js";
import { createExplorerRouter } from "../explorer/handler.js";
import type { Authenticator } from "../auth/types.js";

// Register apcore-a2a config namespace (stable in apcore-js >= 0.22.0)
Config.registerNamespace({
  name: "apcore-a2a",
  envPrefix: "APCORE_A2A",
  defaults: {
    execution_timeout: 300,
    cors_origins: [],
    explorer: false,
    metrics: false,
    push_notifications: false,
  },
});

// Register error formatter for the a2a adapter (stable top-level export in apcore-js >= 0.22.0)
try {
  ErrorFormatterRegistry.register("a2a", new ErrorMapper());
} catch {
  // Already registered; skip
}

const ACTIVE_STATES = new Set(["submitted", "working", "input-required"]);

/**
 * In-process counters for the A2A `/metrics` endpoint. These count A2A
 * task-state transitions (submitted/working/completed/...) on the wire
 * protocol, a distinct concern from apcore's per-module observability metrics
 * (latency, error rates) collected via ObsLoggingMiddleware /
 * ErrorHistoryMiddleware. The two are intentionally separate.
 */
class MetricsState {
  activeTasks = 0;
  completedTasks = 0;
  failedTasks = 0;
  canceledTasks = 0;
  inputRequiredTasks = 0;
  totalRequests = 0;
  private startTime = performance.now();

  uptimeSeconds(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  onStateTransition(oldState: string, newState: string): void {
    const wasActive = ACTIVE_STATES.has(oldState);
    const nowActive = ACTIVE_STATES.has(newState);

    if (!wasActive && nowActive) this.activeTasks++;
    else if (wasActive && !nowActive) this.activeTasks = Math.max(0, this.activeTasks - 1);

    if (newState === "completed") this.completedTasks++;
    else if (newState === "failed") this.failedTasks++;
    else if (newState === "canceled") this.canceledTasks++;
    else if (newState === "input-required") this.inputRequiredTasks++;
  }
}

export interface A2AServerCreateOptions {
  name: string;
  description: string;
  version: string;
  url: string;
  /**
   * Custom task store. Participates in *enforcement*, not just storage: every
   * task-addressed method is scoped to the authenticated principal by the
   * store's own owner resolution, driven by the `ServerCallContext` this
   * factory builds from the authenticated `Identity`.
   *
   * **A store that ignores its `ServerCallContext` argument disables task
   * scoping entirely** -- every caller sees every caller's tasks. a2a-js's
   * `InMemoryTaskStore` scopes by `ownerResolver`; a third-party store must do
   * the same. Upstream states the requirement as a SHOULD on the `TaskStore`
   * contract, so it cannot be enforced here.
   */
  taskStore?: TaskStore;
  auth?: Authenticator;
  executionTimeout?: number;
  corsOrigins?: string[];
  pushNotifications?: boolean;
  explorer?: boolean;
  explorerPrefix?: string;
  metrics?: boolean;
  sysModules?: boolean;
}

export class A2AServerFactory {
  private schemaConverter = new SchemaConverter();
  private skillMapper = new SkillMapper(this.schemaConverter);
  private agentCardBuilder = new AgentCardBuilder(this.skillMapper);
  private partConverter = new PartConverter(this.schemaConverter);
  private registry?: Registry;

  create(
    registry: Registry,
    executor: {
      callAsync(
        moduleId: string,
        inputs?: Record<string, unknown> | null,
        context?: unknown,
      ): Promise<Record<string, unknown>>;
    },
    opts: A2AServerCreateOptions,
  ): { app: Express; agentCard: AgentCard } {
    this.registry = registry;

    // Wire apcore system modules + observability middleware onto the executor
    // when it supports `.use()` (mirrors the Python binding). Duck-typed since
    // the create() executor type only requires callAsync.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supportsUse = typeof (executor as any).use === "function";

    // P1-B: register sys.* modules BEFORE building the AgentCard so they appear
    // as skills. Requires sysModules=true and an executor exposing .use().
    if (opts.sysModules && supportsUse) {
      try {
        const registryCfg = ((registry as unknown as { config?: Record<string, unknown> }).config ??
          {}) as Record<string, unknown>;
        const apcoreCfg = (registryCfg.apcore ?? {}) as Record<string, unknown>;
        const sysCfg = (apcoreCfg.sys_modules ?? {}) as Record<string, unknown>;
        const sysData = {
          ...registryCfg,
          apcore: { ...apcoreCfg, sys_modules: { ...sysCfg, enabled: true } },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSysModules(registry as any, executor as any, new Config(sysData));
      } catch {
        // Continue without sys modules if registration fails.
      }
    }

    // P1-A: structured per-call logging (always; low overhead). Error-history
    // tracking only when metrics is on and sys modules are not (which may
    // already install error tracking), matching the Python binding.
    if (supportsUse) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (executor as any).use(new ObsLoggingMiddleware());
        if (opts.metrics && !opts.sysModules) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (executor as any).use(new ErrorHistoryMiddleware(new ErrorHistory()));
        }
      } catch {
        // Observability middleware is best-effort.
      }
    }

    // Build security schemes
    const securitySchemes = opts.auth ? opts.auth.securitySchemes() : undefined;

    // Build capabilities (a2a-js 1.0 AgentCapabilities shape)
    const capabilities: AgentCapabilities = {
      streaming: true,
      pushNotifications: opts.pushNotifications ?? false,
      extensions: [],
      // Offered whenever an authenticator is configured (Python/Rust parity:
      // extended_agent_card = auth is not None), independent of whether the
      // authenticator returns any security schemes.
      extendedAgentCard: opts.auth != null,
    };

    // Build AgentCard
    const agentCard = this.agentCardBuilder.build(registry, {
      name: opts.name,
      description: opts.description,
      version: opts.version,
      url: opts.url,
      capabilities,
      securitySchemes: securitySchemes as Record<string, unknown> | undefined,
    }) as AgentCard;

    // Build metrics state
    const metricsState = new MetricsState();

    // Build executor
    const onStateChange = opts.metrics
      ? (o: string, n: string) => metricsState.onStateTransition(o, n)
      : undefined;

    const apcoreExecutor = new ApCoreAgentExecutor({
      executor,
      partConverter: this.partConverter,
      registry,
      executionTimeout: opts.executionTimeout,
      onStateChange,
    });

    // Build task store
    const taskStore = opts.taskStore ?? new InMemoryTaskStore();

    // Build DefaultRequestHandler
    const requestHandler = new DefaultRequestHandler(
      agentCard,
      taskStore,
      apcoreExecutor,
      new DefaultExecutionEventBusManager(),
    );

    // Build Express app
    const app = express();
    app.use(express.json());

    const explorerPrefix = opts.explorerPrefix ?? "/explorer";

    // Auth middleware (before routes)
    if (opts.auth) {
      const exemptPrefixes = opts.explorer ? new Set([explorerPrefix]) : new Set<string>();
      app.use(
        createAuthMiddleware({
          authenticator: opts.auth,
          exemptPrefixes,
        }),
      );
    }

    // CORS middleware
    if (opts.corsOrigins && opts.corsOrigins.length > 0) {
      const origins = new Set(opts.corsOrigins);
      app.use((req: Request, res: Response, next) => {
        const origin = req.headers.origin;
        if (origin && origins.has(origin)) {
          res.set("Access-Control-Allow-Origin", origin);
          res.set("Access-Control-Allow-Methods", "GET, POST");
          res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        }
        if (req.method === "OPTIONS") {
          res.status(204).end();
          return;
        }
        next();
      });
    }

    // Request counter middleware
    if (opts.metrics) {
      app.use((req: Request, _res: Response, next) => {
        if (req.method === "POST") metricsState.totalRequests++;
        next();
      });
    }

    // Agent card endpoint
    // agentCardHandler() returns a router that responds at its mount root ("/"),
    // so it must be mounted with app.use(path, ...) rather than app.get(path, ...).
    // A2A 1.0 primary endpoint
    app.use(
      "/.well-known/agent-card.json",
      agentCardHandler({ agentCardProvider: requestHandler }),
    );
    // A2A 0.3 alias (kept for backward compatibility)
    app.use(
      "/.well-known/agent.json",
      agentCardHandler({ agentCardProvider: requestHandler }),
    );

    // JSON-RPC endpoint.
    // userBuilder: bind the authenticated principal to the ServerCallContext so
    // a2a-js's owner-scoped stores scope every task-addressed method to its
    // owner. With UserBuilder.noAuthentication every caller shared the
    // UnauthenticatedUser bucket and tasks/list returned every caller's tasks.
    app.post(
      "/",
      jsonRpcHandler({
        requestHandler,
        userBuilder: identityUserBuilder,
        legacyCompat: { enabled: true },
      }),
    );

    // REST transport endpoints (A2A HTTP+JSON/REST protocol)
    app.use(
      restHandler({
        requestHandler,
        userBuilder: identityUserBuilder,
        legacyCompat: { enabled: true },
      }),
    );

    // Explorer UI
    if (opts.explorer) {
      app.use(explorerPrefix, createExplorerRouter(agentCard, { registry }));
    }

    // Health endpoint
    app.get("/health", async (_req: Request, res: Response) => {
      let moduleCount = 0;
      try {
        moduleCount = registry.list().length;
      } catch {
        // ignore
      }

      try {
        // a2a-js 1.0 TaskStore.load requires a ServerCallContext (tenant /
        // owner scoping). Explicitly the anonymous owner bucket: the probe must
        // not read a principal's tasks, and the id it asks for exists in no
        // bucket anyway.
        await taskStore.load("__health_probe__", anonymousContext());
      } catch {
        res.status(503).json({
          status: "unhealthy",
          reason: "Task store unavailable",
          uptimeSeconds: metricsState.uptimeSeconds(),
          moduleCount,
          version: opts.version,
        });
        return;
      }

      res.json({
        status: "healthy",
        uptimeSeconds: metricsState.uptimeSeconds(),
        moduleCount,
        version: opts.version,
      });
    });

    // Metrics endpoint
    if (opts.metrics) {
      app.get("/metrics", (_req: Request, res: Response) => {
        res.json({
          activeTasks: metricsState.activeTasks,
          completedTasks: metricsState.completedTasks,
          failedTasks: metricsState.failedTasks,
          canceledTasks: metricsState.canceledTasks,
          inputRequiredTasks: metricsState.inputRequiredTasks,
          totalRequests: metricsState.totalRequests,
          uptimeSeconds: metricsState.uptimeSeconds(),
        });
      });
    }

    return { app, agentCard };
  }

  registerModule(moduleId: string, descriptor: unknown): void {
    if (this.registry?.register) {
      this.registry.register(moduleId, descriptor);
    }
    this.agentCardBuilder.invalidateCache();
  }
}
