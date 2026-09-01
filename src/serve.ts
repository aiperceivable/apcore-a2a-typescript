import http from "node:http";
import type { Express } from "express";
import { Config } from "apcore-js";
import { A2AServerFactory } from "./server/factory.js";
import type { Registry } from "./adapters/agent-card.js";
import type { Authenticator } from "./auth/types.js";
import type { TaskStore } from "@a2a-js/sdk/server";

const A2A_NAMESPACE = "apcore-a2a";
const DEFAULT_EXECUTION_TIMEOUT = 300; // seconds (matches the registered namespace default)

/**
 * Resolve the task execution timeout (seconds).
 *
 * Precedence: explicit option > apcore Config (`apcore-a2a.execution_timeout`,
 * incl. `APCORE_A2A_EXECUTION_TIMEOUT` env override in namespace mode) > bare
 * `APCORE_A2A_EXECUTION_TIMEOUT` env var (honored even without a config file) >
 * the registered namespace default. Mirrors the Python binding.
 */
function resolveExecutionTimeout(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromConfig = Config.load(undefined, { validate: false }).get(
    `${A2A_NAMESPACE}.execution_timeout`,
  );
  if (fromConfig !== undefined && fromConfig !== null) return Number(fromConfig);
  const env = process.env.APCORE_A2A_EXECUTION_TIMEOUT;
  if (env !== undefined) return parseInt(env, 10);
  return DEFAULT_EXECUTION_TIMEOUT;
}

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
  pushNotifications?: boolean;
  explorer?: boolean;
  explorerPrefix?: string;
  executionTimeout?: number;
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
   * is what the apcore MCP binding reports today. A server facing untrusted
   * callers keeps the default.
   */
  discloseRefusalReason?: boolean;
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
    if (typeof nestedExecutor?.callAsync === "function") {
      return { registry, executor: nestedExecutor };
    }
    // Registry only — return as-is; asyncServe will create the Executor
    return { registry, executor: registry as unknown as ExecutorLike };
  }

  throw new TypeError("Expected apcore Registry or Executor");
}

/**
 * If the resolved executor doesn't have callAsync, attempt to create
 * an apcore Executor from the registry automatically.
 */
async function ensureExecutor(
  resolved: { registry: RegistryWithConfig; executor: ExecutorLike },
): Promise<{ registry: RegistryWithConfig; executor: ExecutorLike }> {
  if (typeof resolved.executor.callAsync === "function") {
    return resolved;
  }
  // The "executor" is actually the registry (no callAsync) — create a real Executor
  try {
    const { Executor } = await import("apcore-js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executor = Executor.fromRegistry(resolved.registry as any) as unknown as ExecutorLike;
    return { registry: resolved.registry, executor };
  } catch {
    throw new TypeError(
      "Registry has no callAsync method and apcore-js Executor could not be created. " +
        "Pass an Executor instance instead of a bare Registry.",
    );
  }
}

export async function asyncServe(
  registryOrExecutor: unknown,
  opts: AsyncServeOptions = {},
): Promise<Express> {
  const { registry, executor } = await ensureExecutor(
    resolveRegistryAndExecutor(registryOrExecutor),
  );

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
    pushNotifications: opts.pushNotifications,
    explorer: opts.explorer,
    explorerPrefix: opts.explorerPrefix,
    executionTimeout: resolveExecutionTimeout(opts.executionTimeout),
    metrics: opts.metrics,
    sysModules: opts.sysModules,
    discloseRefusalReason: opts.discloseRefusalReason,
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

      // Track open connections so we can destroy them on shutdown
      const connections = new Set<import("net").Socket>();
      server.on("connection", (conn) => {
        connections.add(conn);
        conn.on("close", () => connections.delete(conn));
      });

      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;

        // Destroy idle keep-alive connections so server.close() can finish
        for (const conn of connections) {
          conn.destroy();
        }
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
