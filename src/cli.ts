#!/usr/bin/env node

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function printUsage(): void {
  console.log(`
apcore-a2a - A2A Protocol Server for apcore modules

Usage:
  apcore-a2a serve --extensions-dir <path> [options]

Required:
  --extensions-dir <path>    Path to apcore extensions directory

Options:
  --host <address>           Bind host (default: 127.0.0.1)
  --port <number>            Bind port (default: 8000)
  --name <string>            Agent name
  --description <string>     Agent description
  --version-str <string>     Agent version
  --url <string>             Public URL
  --auth-type <type>         Auth type: bearer
  --auth-key <key>           JWT secret key (literal, file path, or JWT_SECRET env)
  --auth-issuer <string>     JWT issuer
  --auth-audience <string>   JWT audience
  --push-notifications       Enable push notifications
  --explorer                 Enable explorer UI
  --cors-origins <origins>   Comma-separated CORS origins
  --execution-timeout <ms>   Execution timeout in ms (default: 300000)
  --log-level <level>        Log level: debug, info, warning, error
  --metrics                  Enable metrics endpoint
  --version                  Show version
  --help                     Show this help
`);
}

function fail(message: string, exitCode: number = 1): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

export function resolveAuthKey(authKey?: string): string | undefined {
  if (authKey) {
    try {
      if (existsSync(authKey) && statSync(authKey).isFile()) {
        return readFileSync(authKey, "utf-8").trim();
      }
    } catch {
      // not a file, use as literal
    }
    return authKey;
  }
  return process.env.JWT_SECRET;
}

export async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        "extensions-dir": { type: "string" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8000" },
        name: { type: "string" },
        description: { type: "string" },
        "version-str": { type: "string" },
        url: { type: "string" },
        "auth-type": { type: "string" },
        "auth-key": { type: "string" },
        "auth-issuer": { type: "string" },
        "auth-audience": { type: "string" },
        "push-notifications": { type: "boolean", default: false },
        explorer: { type: "boolean", default: false },
        "cors-origins": { type: "string" },
        "execution-timeout": { type: "string", default: "300000" },
        "log-level": { type: "string", default: "info" },
        metrics: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (e) {
    fail(String(e));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    printUsage();
    return;
  }

  if (values.version) {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    console.log(`apcore-a2a v${pkg.version}`);
    return;
  }

  const command = positionals[0];
  if (command !== "serve") {
    printUsage();
    process.exit(1);
  }

  await runServe(values);
}

async function runServe(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const extensionsDir = values["extensions-dir"] as string | undefined;
  if (!extensionsDir) {
    fail("--extensions-dir is required");
  }

  const resolved = resolve(extensionsDir);
  if (!existsSync(resolved)) {
    fail(`Extensions directory not found: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    fail(`Not a directory: ${resolved}`);
  }

  // Load registry
  const { Registry } = await import("apcore-js");
  const registry = new Registry({ extensionsDir: resolved });
  const modules = registry.list();
  if (modules.length === 0) {
    fail(`No modules discovered in ${resolved}`);
  }
  console.log(`Discovered ${modules.length} module(s): ${modules.join(", ")}`);

  // Build auth
  let auth;
  if (values["auth-type"] === "bearer") {
    const key = resolveAuthKey(values["auth-key"] as string | undefined);
    if (!key) {
      fail("--auth-key is required when --auth-type is bearer");
    }
    const { JWTAuthenticator } = await import("./auth/jwt.js");
    auth = new JWTAuthenticator(key, {
      issuer: values["auth-issuer"] as string | undefined,
      audience: values["auth-audience"] as string | undefined,
    });
  }

  const host = (values.host as string) ?? "127.0.0.1";
  const port = parseInt((values.port as string) ?? "8000", 10);

  // Warn on 0.0.0.0 without auth
  if (host === "0.0.0.0" && !auth) {
    console.warn(
      "Warning: --host 0.0.0.0 binds to all network interfaces without authentication; " +
        "consider using --host 127.0.0.1 or enabling --auth-type bearer",
    );
  }

  const corsOrigins = values["cors-origins"]
    ? (values["cors-origins"] as string).split(",").map((s) => s.trim())
    : undefined;

  const { serve } = await import("./serve.js");
  serve(registry, {
    host,
    port,
    name: values.name as string | undefined,
    description: values.description as string | undefined,
    version: values["version-str"] as string | undefined,
    url: values.url as string | undefined,
    auth,
    explorer: !!values.explorer,
    corsOrigins,
    executionTimeout: parseInt((values["execution-timeout"] as string) ?? "300000", 10),
    logLevel: values["log-level"] as string | undefined,
    metrics: !!values.metrics,
  });
}

// Only run when executed directly (not imported in tests)
const thisFile = fileURLToPath(import.meta.url);
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(thisFile);

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
