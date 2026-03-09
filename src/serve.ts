import http from "node:http";
import type { Express } from "express";
import { A2AServerFactory } from "./server/factory.js";
import type { Registry } from "./adapters/agent-card.js";
import type { Authenticator } from "./auth/types.js";
import type { TaskStore } from "@a2a-js/sdk/server";

const DEFAULT_EXECUTION_TIMEOUT = parseInt(
  process.env.A2A_EXECUTION_TIMEOUT ?? "300000",
  10,
);

const AUTH_REQUIRED = ["authenticate", "securitySchemes"] as const;
const TASK_STORE_REQUIRED = ["save", "load"] as const;

export interface AsyncServeOptions {
  name?: string;
  description?: string;
  version?: string;
  url?: string;
  auth?: Authenticator;
  taskStore?: TaskStore;
  corsOrigins?: string[];
  explorer?: boolean;
  explorerPrefix?: string;
  executionTimeout?: number;
  metrics?: boolean;
}

export interface ServeOptions extends AsyncServeOptions {
  host?: string;
  port?: number;
  logLevel?: string;
  shutdownTimeout?: number;
}

interface RegistryWithConfig extends Registry {
  config?: Record<string, unknown>;
}

interface ExecutorLike {
  callAsync(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: unknown,
  ): Promise<Record<string, unknown>>;
  registry?: RegistryWithConfig;
}

export function resolveRegistryAndExecutor(
  obj: unknown,
): { registry: RegistryWithConfig; executor: ExecutorLike } {
  const o = obj as Record<string, unknown>;

  // Check executor first (more specific — callAsync is distinctive)
  if (typeof o.callAsync === "function") {
    const executor = o as unknown as ExecutorLike;
    const registry = executor.registry;
    if (!registry) {
      throw new TypeError(
        "Expected apcore Registry or Executor: executor has no .registry property",
      );
    }
    return { registry, executor };
  }

  if (typeof o.list === "function" && typeof o.getDefinition === "function") {
    const registry = o as unknown as RegistryWithConfig;
    const nestedExecutor = (o as Record<string, unknown>).executor as ExecutorLike | undefined;
    const executor =
      typeof nestedExecutor?.callAsync === "function"
        ? nestedExecutor
        : (registry as unknown as ExecutorLike);
    return { registry, executor };
  }

  throw new TypeError("Expected apcore Registry or Executor");
}

export async function asyncServe(
  registryOrExecutor: unknown,
  opts: AsyncServeOptions = {},
): Promise<Express> {
  const { registry, executor } = resolveRegistryAndExecutor(registryOrExecutor);

  // Validate registry has at least one module
  const modules = registry.list();
  if (modules.length === 0) {
    throw new ValueError(
      "Registry contains zero modules; at least one module is required to serve an A2A agent",
    );
  }

  // Resolve metadata with fallbacks
  const projectConfig =
    ((registry.config as Record<string, unknown>)?.project as Record<string, unknown>) ?? {};
  const resolvedName = opts.name ?? (projectConfig.name as string) ?? "Apcore Agent";
  const resolvedVersion = opts.version ?? (projectConfig.version as string) ?? "0.0.0";
  const resolvedDescription =
    opts.description ??
    (projectConfig.description as string) ??
    `apcore agent with ${modules.length} skills`;

  // Protocol validation
  if (opts.auth) {
    const missing = AUTH_REQUIRED.filter(
      (m) => typeof (opts.auth as unknown as Record<string, unknown>)[m] !== "function",
    );
    if (missing.length > 0) {
      throw new TypeError(`auth missing required methods: ${missing.join(", ")}`);
    }
  }

  if (opts.taskStore) {
    const missing = TASK_STORE_REQUIRED.filter(
      (m) => typeof (opts.taskStore as unknown as Record<string, unknown>)[m] !== "function",
    );
    if (missing.length > 0) {
      throw new TypeError(`taskStore missing required methods: ${missing.join(", ")}`);
    }
  }

  const factory = new A2AServerFactory();
  const { app } = factory.create(registry, executor, {
    name: resolvedName,
    description: resolvedDescription,
    version: resolvedVersion,
    url: opts.url ?? "http://localhost:8000",
    taskStore: opts.taskStore,
    auth: opts.auth,
    corsOrigins: opts.corsOrigins,
    explorer: opts.explorer,
    explorerPrefix: opts.explorerPrefix,
    executionTimeout: opts.executionTimeout ?? DEFAULT_EXECUTION_TIMEOUT,
    metrics: opts.metrics,
  });

  return app;
}

export function serve(
  registryOrExecutor: unknown,
  opts: ServeOptions = {},
): void {
  const host = opts.host ?? "0.0.0.0";
  const port = opts.port ?? 8000;
  const resolvedUrl = opts.url ?? `http://${host}:${port}`;

  asyncServe(registryOrExecutor, { ...opts, url: resolvedUrl })
    .then((app) => {
      const server = http.createServer(app);

      const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), (opts.shutdownTimeout ?? 30) * 1000);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);

      server.listen(port, host, () => {
        console.log(`A2A agent listening on ${resolvedUrl}`);
      });
    })
    .catch((e) => {
      console.error(`Failed to start A2A agent: ${e}`);
      process.exit(1);
    });
}

class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
