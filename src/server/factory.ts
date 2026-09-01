import express from "express";
import type { Express, Request, Response } from "express";
import type { AgentCard, AgentCapabilities } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  DefaultExecutionEventBusManager,
  InMemoryTaskStore,
  type ServerCallContext,
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
import {
  buildExtendedCard,
  buildPublicCard,
  type RegistryLike,
} from "../adapters/card-visibility.js";
import { getAuthIdentity } from "../auth/storage.js";
import { PartConverter } from "../adapters/parts.js";
import { ErrorMapper } from "../adapters/errors.js";
import { ApCoreAgentExecutor } from "./executor.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { anonymousContext, identityOf, identityUserBuilder } from "./context.js";
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
  /**
   * Forward apcore's own reason for a governance refusal (ACL denial, approval
   * denial, approval timeout) instead of the fixed per-class string
   * (srs FR-ERR-011). Off by default.
   *
   * The *class* of refusal is conveyed either way — each has its own JSON-RPC
   * code and a `rejected` task state; this decides only whether the *detail*
   * travels with it. A server whose callers are its own agents wants it on: that
   * is what the apcore MCP binding reports today, so an operator comparing the
   * two transports otherwise sees the reason on one and not the other.
   */
  discloseRefusalReason?: boolean;
}

/** The shape of apcore's `Executor.governanceState()` this module reads. */
interface GovernanceStateLike {
  readonly unprotectedControlSurface?: boolean;
}

/**
 * Warn when `system.control.*` is served with nothing gating it (srs FR-AGC-007).
 *
 * Reads apcore's `Executor.governanceState()` (apcore PROTOCOL_SPEC §6.6.5),
 * which answers "is a gate *engaging*" rather than "is an ACL *attached*" — the
 * ACL and approval gates are pipeline *steps*, and the `internal`, `testing` and
 * `minimal` strategies remove them, so an executor can hold an ACL that no step
 * ever consults. Re-deriving the question from the raw `acl` / `approvalHandler`
 * fields would answer the wrong one, and apcore-js does not expose them anyway.
 *
 * Withholding `system.*` from the public card (FR-AGC-003 criterion 12) removes
 * the surface from *discovery*, not from *dispatch*: apcore's approval gate warns
 * once and continues when no `ApprovalHandler` is configured, so the write
 * modules stay callable. This warning exists so the card rule cannot be mistaken
 * for a fix to that. apcore deliberately made the accessor a pure read and left
 * the reaction to the adapter; warning is the reaction, and a failure to read it
 * must never stop a server from starting.
 */
function warnOnUnprotectedControlSurface(executor: unknown): void {
  const accessor = (executor as { governanceState?: () => GovernanceStateLike } | null)
    ?.governanceState;
  if (typeof accessor !== "function") return;
  let state: GovernanceStateLike;
  try {
    state = accessor.call(executor);
  } catch {
    // A diagnostic must never break startup.
    return;
  }
  // `=== true` and not truthiness: a test double answers every property with a
  // truthy stand-in, and a diagnostic that cries wolf in every suite is one
  // nobody reads.
  if (state?.unprotectedControlSurface === true) {
    console.warn(
      "apcore system.control.* modules are registered and no built-in governance gate " +
        "engages for them (no ACL, no ApprovalHandler, or a strategy without the gates). " +
        "They are withheld from the public Agent Card but remain callable. Configure an " +
        "acl/ directory, an ApprovalHandler, or ExecutionPolicy with strict=true.",
    );
  }
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

    // P1-B: register system.* modules BEFORE building the AgentCard so they are
    // subject to the same visibility rules as every other skill.
    // Requires sysModules=true and an executor exposing .use().
    if (opts.sysModules && supportsUse) {
      try {
        // `sys_modules` is a TOP-LEVEL section of apcore's config, and
        // `registerSysModules` reads `config.get('sys_modules.enabled')` in
        // legacy mode. Nesting it under `apcore:` — as this did — meant the
        // lookup missed, the function returned at its first line, and
        // `sysModules: true` registered nothing (apcore-a2a#5). Any operator
        // settings found under either spelling are carried through, top-level
        // winning — apcore's own `Registry` exposes no `config`, so this reads a
        // host-supplied one and is `{}` in the ordinary case.
        // `sys_modules.events` has no route in through this binding, so
        // `sysModules: true` alone registers the six read modules and no
        // `system.control.*`.
        const registryCfg = ((registry as unknown as { config?: Record<string, unknown> }).config ??
          {}) as Record<string, unknown>;
        const apcoreCfg = (registryCfg.apcore ?? {}) as Record<string, unknown>;
        const nestedSys = (apcoreCfg.sys_modules ?? {}) as Record<string, unknown>;
        const topSys = (registryCfg.sys_modules ?? {}) as Record<string, unknown>;
        const sysData = {
          ...registryCfg,
          sys_modules: { ...nestedSys, ...topSys, enabled: true },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSysModules(registry as any, executor as any, new Config(sysData));
      } catch (e) {
        // Continue without sys modules — but say so. A bare `catch {}` here is
        // the same defect apcore-a2a#5 was made of: an outcome nobody can
        // observe.
        console.warn(`registerSysModules failed — continuing without system modules: ${e}`);
      }
      // Reported separately from the call above, and never inside its `try`: a
      // registry that cannot be enumerated must not be logged as a registration
      // failure.
      try {
        const registered = registry
          .list()
          .filter((id: string) => id.startsWith("system."))
          .sort();
        console.info(`Registered apcore system modules: ${registered.join(", ") || "none"}`);
      } catch {
        // Enumeration is a log detail, not a startup condition.
      }
    }

    warnOnUnprotectedControlSurface(executor);

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
      // Advertised only when this binding actually serves it (srs FR-AGC-006).
      // With an authenticator configured, `GET /agent/authenticatedExtendedCard`
      // and the `GetExtendedAgentCard` JSON-RPC method are both wired below, so
      // the flag and the behaviour agree. Without one, the endpoint 404s and
      // this stays false — a client is entitled to read the flag and call the
      // method (A2A §3.2.x), so advertising an unserved capability is worse than
      // not advertising it.
      extendedAgentCard: opts.auth != null,
    };

    // Build the FULL AgentCard; the public and extended views are derived from
    // it below (srs FR-AGC-003 / FR-AGC-004).
    const fullCard = this.agentCardBuilder.build(registry, {
      name: opts.name,
      description: opts.description,
      version: opts.version,
      url: opts.url,
      capabilities,
      securitySchemes: securitySchemes as Record<string, unknown> | undefined,
    }) as AgentCard;

    // The public card is filtered for the anonymous principal once, here, rather
    // than per request on an auth-exempt route. Before this, every registered
    // skill was advertised to any anonymous caller — id, name, description and
    // full input schema — with the ACL consulted nowhere.
    const agentCard = buildPublicCard(
      fullCard,
      executor,
      registry as unknown as RegistryLike,
    );

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
      discloseRefusalReason: opts.discloseRefusalReason,
    });

    // Build task store
    const taskStore = opts.taskStore ?? new InMemoryTaskStore();

    // Build DefaultRequestHandler.
    //
    // `extendedAgentCardProvider` is a *function* of the ServerCallContext, which
    // is what makes a per-caller extended card possible: the answer to "what may
    // you call" depends on who is asking (srs FR-AGC-004). This binding used to
    // pass nothing at all while still advertising
    // `capabilities.extendedAgentCard`, so a client that read the flag and
    // called `GetExtendedAgentCard` — which A2A §3.2.x entitles it to do — got a
    // method error.
    const extendedAgentCardProvider =
      opts.auth != null
        ? (context: ServerCallContext): Promise<AgentCard> =>
            Promise.resolve(buildExtendedCard(fullCard, executor, identityOf(context)))
        : undefined;

    const requestHandler = new DefaultRequestHandler(
      agentCard,
      taskStore,
      apcoreExecutor,
      new DefaultExecutionEventBusManager(),
      undefined,
      undefined,
      extendedAgentCardProvider,
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

    // Extended Agent Card (srs FR-AGC-004). Registered after the auth
    // middleware, so an unauthenticated request is rejected there rather than
    // here. 404 without an authenticator, which is the same condition under
    // which `capabilities.extendedAgentCard` is false.
    //
    // This binding previously advertised the capability and routed nothing, so a
    // client that read the flag and called the method got a 404 with no
    // explanation of why a capability it was told about did not exist.
    app.get("/agent/authenticatedExtendedCard", (_req: Request, res: Response) => {
      if (opts.auth == null) {
        res.status(404).json({ error: "Extended agent card is not configured" });
        return;
      }
      res.json(buildExtendedCard(fullCard, executor, getAuthIdentity()));
    });

    // JSON-RPC endpoint.
    // userBuilder: bind the authenticated principal to the ServerCallContext so
    // a2a-js's owner-scoped stores scope every task-addressed method to its
    // owner. With UserBuilder.noAuthentication every caller shared the
    // UnauthenticatedUser bucket and ListTasks returned every caller's tasks.
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
