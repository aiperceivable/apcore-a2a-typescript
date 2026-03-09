import express from "express";
import type { Express, Request, Response } from "express";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  DefaultExecutionEventBusManager,
  InMemoryTaskStore,
  type TaskStore,
} from "@a2a-js/sdk/server";
import {
  jsonRpcHandler,
  agentCardHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

import { SkillMapper } from "../adapters/skill-mapper.js";
import { SchemaConverter } from "../adapters/schema.js";
import { AgentCardBuilder, type Registry } from "../adapters/agent-card.js";
import { PartConverter } from "../adapters/parts.js";
import { ApCoreAgentExecutor } from "./executor.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createExplorerRouter } from "../explorer/handler.js";
import type { Authenticator } from "../auth/types.js";

const ACTIVE_STATES = new Set(["submitted", "working", "input-required"]);

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
  taskStore?: TaskStore;
  auth?: Authenticator;
  executionTimeout?: number;
  corsOrigins?: string[];
  explorer?: boolean;
  explorerPrefix?: string;
  metrics?: boolean;
}

export class A2AServerFactory {
  private skillMapper = new SkillMapper();
  private schemaConverter = new SchemaConverter();
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

    // Build security schemes
    const securitySchemes = opts.auth ? opts.auth.securitySchemes() : undefined;

    // Build capabilities
    const capabilities = {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
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
    app.get(
      "/.well-known/agent-card.json",
      agentCardHandler({ agentCardProvider: requestHandler }),
    );

    // JSON-RPC endpoint
    app.post(
      "/",
      jsonRpcHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
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
        await taskStore.load("__health_probe__");
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
