#!/usr/bin/env node

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Registry as ApcoreRegistry } from "apcore-js";

function printUsage(): void {
  console.log(`
apcore-a2a - A2A Protocol Server for apcore modules

Usage:
  apcore-a2a serve --extensions-dir <path> [options]
  apcore-a2a serve --from-openapi <url|path> [options]

Required (at least one backend source):
  --extensions-dir <path>    Path to apcore extensions directory
  --from-openapi <url|path>  OpenAPI 3.0/3.1 document to serve as A2A Skills.
                             Combine with --extensions-dir only when
                             --openapi-prefix is also given

  An apcore-a2a.openapi.spec in your apcore config counts as a backend source
  too, so neither flag is required when the config file names one.

OpenAPI backend options (each overrides the matching apcore-a2a.openapi key;
keys with no flag -- timeout, headers, acknowledge_unapproved_writes -- are
configured there):
  --openapi-base-url <url>   Base URL for proxied calls (default: servers[0].url)
  --openapi-prefix <string>  Prefix for every derived module ID
  --openapi-include <regex>  Scanner include filter
  --openapi-exclude <regex>  Scanner exclude filter
  --openapi-header <K:V>     Header for the SPEC FETCH only, repeatable.
                             Never forwarded to proxied calls
  --openapi-no-deprecated    Skip operations marked deprecated: true

Options:
  --host <address>           Bind host (default: 127.0.0.1)
  --port <number>            Bind port (default: 8000)
  --name <string>            Agent name
  --description <string>     Agent description
  --version-str <string>     Agent version
  --url <string>             Public URL
  --auth-type <type>         Auth type: bearer
  --auth-key <key>           JWT secret key (literal, file path, or APCORE_JWT_SECRET env)
  --auth-issuer <string>     JWT issuer
  --auth-audience <string>   JWT audience
  --push-notifications       Enable push notifications
  --explorer                 Enable explorer UI
  --cors-origins <origins>   Comma-separated CORS origins
  --execution-timeout <sec>   Execution timeout in seconds (default: 300)
  --log-level <level>        Log level: debug, info, warning, error
  --metrics                  Enable metrics endpoint
  --version                  Show version
  --help                     Show this help
`);
}

/**
 * The `values` half of a `parseArgs` result under `strict: false`.
 *
 * Wider than the flag table suggests on purpose: with `strict: false` node
 * accepts `--metrics=x` for a boolean and repeats for a non-`multiple` option,
 * so every entry may arrive as a string, a boolean, or an array of either.
 */
type CliValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/**
 * Exit `1` — a configuration or runtime error.
 *
 * The command line was well-formed; the environment it named was not. A
 * supervisor may retry these, because the world can become ready.
 */
function fail(message: string, exitCode: number = 1): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

/**
 * Exit `2` — a usage error. The command line itself is wrong.
 *
 * Distinguished from {@link fail} because retrying an exit-2 command unchanged
 * will always fail, while an exit-1 command may succeed once the directory,
 * config or network it named is fixed. That is a difference a supervisor or CI
 * job can act on, and this SDK previously collapsed both onto `1` — losing a
 * distinction Python's argparse and Rust's clap each provide for free.
 *
 * `2` rather than some other number because it is what argparse, clap and GNU
 * getopt all use for a usage fault, so the three bindings agree with each other
 * and with the tools around them.
 */
export function failUsage(message: string): never {
  return fail(message, 2);
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
  return process.env.APCORE_JWT_SECRET;
}

/**
 * Parse `serve`'s argv.
 *
 * Split out of {@link main} so the flag surface is reachable without starting a
 * server: the `--openapi-no-deprecated` contract is half in this table (no
 * `default`) and half in {@link mergeOpenapiSettings} (the presence check), and
 * either half alone silently reverses a config `include_deprecated: false`.
 */
export function parseCliArgs(args?: string[]): ReturnType<typeof parseArgs> {
  const config = {
    options: {
      "extensions-dir": { type: "string" },
      "from-openapi": { type: "string" },
      "openapi-base-url": { type: "string" },
      "openapi-prefix": { type: "string" },
      "openapi-include": { type: "string" },
      "openapi-exclude": { type: "string" },
      "openapi-header": { type: "string", multiple: true },
      // Deliberately NO `default: false`. `mergeOpenapiSettings` has to tell
      // "not passed" from "passed", because a `false` default would make an
      // absent flag overwrite a config `include_deprecated: false` with `true`
      // — an unpassed flag silently reversing a setting the operator wrote.
      // Same reason the Python binding uses `default=None`.
      "openapi-no-deprecated": { type: "boolean" },
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
      "execution-timeout": { type: "string", default: "300" },
      "log-level": { type: "string", default: "info" },
      metrics: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  } as const;
  // `args: undefined` is NOT the same as omitting it — node's own default
  // (`process.argv` minus the execPath and script) knows about `node --` and
  // single-executable builds, and re-deriving it here would drop that.
  const parsed =
    args === undefined ? parseArgs(config) : parseArgs({ ...config, args });
  rejectUnknownArguments(parsed, Object.keys(config.options));
  return parsed;
}

/**
 * Refuse an argument the flag table does not define.
 *
 * `strict: false` is kept deliberately — it is what lets this CLI tolerate
 * `--metrics=x` for a boolean and a repeat of a non-`multiple` option, both of
 * which `strict: true` would turn into throws — but node's tolerance extends to
 * *unknown* flags too, and there it is not tolerance, it is silence.
 *
 * Measured before this check existed, with a one-letter typo:
 *
 * ```
 * apcore-a2a serve --extensions-dir ./ext --openapi-exclde 'secret.*'
 *   values:      { "openapi-exclde": true, ... }   ← the flag became a boolean
 *   positionals: [ "serve", "secret.*" ]           ← its value became a positional
 * ```
 *
 * The exclusion silently did not apply, and every operation it was meant to hold
 * back was scanned, registered, and published to the **public** Agent Card — a
 * route served without authentication and built to be crawled. The server
 * started and reported success.
 *
 * Python's argparse (`unrecognized arguments`) and Rust's clap (`unexpected
 * argument ... found`) both refuse this and exit 2; TypeScript was the only
 * binding that did not, so the tolerant behaviour was never portable — the same
 * argv already failed on the other two.
 *
 * Note argparse additionally accepts unambiguous *abbreviations*, so
 * `--openapi-exclud` is a legal spelling there. That is an argparse feature, not
 * a parity requirement: clap does not do it either, and this check is only about
 * spellings no binding recognises.
 */
function rejectUnknownArguments(
  parsed: ReturnType<typeof parseArgs>,
  known: string[],
): void {
  const unknown = Object.keys(parsed.values).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    failUsage(
      `unrecognized argument${unknown.length > 1 ? "s" : ""}: ` +
        `${unknown.map((k) => `--${k}`).join(", ")}. Run with --help for the flag list`,
    );
  }
  // A stray positional is the same mistake seen from the other side: the value
  // of a misspelled flag lands here, so reporting only the flag would leave the
  // operator wondering where their argument went.
  const strays = parsed.positionals.slice(1);
  if (strays.length > 0) {
    failUsage(
      `unexpected argument${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}. ` +
        "Run with --help for the flag list",
    );
  }
}

export async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseCliArgs();
  } catch (e) {
    // A parseArgs throw is an unknown flag or a missing value: a usage fault.
    failUsage(String(e));
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

/**
 * Parse repeated `--openapi-header "Key: Value"` flags into a header map.
 *
 * These authenticate the **spec fetch only**. They are deliberately not reused
 * for proxied calls: a document is often public while the API behind it is not,
 * and broadcasting a spec-read key on every skill invocation would be a
 * privilege escalation the operator never wrote down.
 */
export function parseOpenapiHeaders(
  raw: string[] | undefined,
): Record<string, string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of raw) {
    const separator = entry.indexOf(":");
    // The separator index alone is not the test. `separator <= 0` rejects ":v"
    // but ACCEPTS " :v" — the colon is at index 1 — and the `.trim()` below then
    // yields an EMPTY header name. Python checks `not key.strip()` and Rust
    // `key.trim().is_empty()`; both reject, so the key is trimmed first and
    // judged afterwards.
    const key = separator > 0 ? entry.slice(0, separator).trim() : "";
    if (!key) {
      // Never echo the value back: the whole point of the flag is that it may
      // carry a credential.
      failUsage(`--openapi-header must be "Key: Value" (got an entry with no ':' or no key)`);
    }
    headers[key] = entry.slice(separator + 1).trim();
  }
  return headers;
}

/**
 * Resolve the OpenAPI backend settings: CLI flags over the Config Bus.
 *
 * Implements the precedence the feature spec states — **an explicit CLI flag
 * beats the `apcore-a2a.openapi` Config Bus section, which beats the default** —
 * and implements it PER KEY, not per source. Choosing the whole source by
 * whoever named `spec` would make a `--openapi-prefix` alongside a
 * config-declared `spec` a silent no-op: the same shape as the apcore-mcp
 * `--openapi-header` defect this project filed upstream (apcore-mcp-rust#8).
 *
 * The returned mapping is in the Config Bus's own snake_case, so it can be
 * handed straight to `buildOpenapiBackendFromConfig` — which is also what makes
 * `timeout`, `include`, `exclude` and `acknowledge_unapproved_writes` reachable
 * from a running server: none of them has a CLI flag, and before this the
 * section had no reader anywhere in `src/`.
 *
 * Returns `null` when neither route yields a `spec`, which is the ordinary "no
 * OpenAPI configured" outcome rather than an error. A section that is not a
 * mapping is returned UNCHANGED — see below.
 */
export async function mergeOpenapiSettings(values: CliValues): Promise<unknown> {
  // Imported lazily so `--help` and `--version` never pay for loading apcore's
  // Config, mirroring the Python binding's function-local import.
  const { getA2aSetting } = await import("./config.js");
  const section = getA2aSetting("openapi");

  // A section that is not a mapping is passed through untouched, so that
  // `buildOpenapiBackendFromConfig` reports it by name ("apcore-a2a.openapi
  // must be a mapping."). Discarding it instead would turn the typo
  // `openapi: ./spec.json` — a mapping's one key written as the whole value —
  // into "a backend source is required", which sends the operator hunting for a
  // missing flag rather than at the line they wrote. Follows the Rust binding,
  // which diverged from the Python reference here for this reason.
  if (section !== undefined && (typeof section !== "object" || Array.isArray(section))) {
    return section;
  }
  const merged: Record<string, unknown> = {
    ...((section ?? {}) as Record<string, unknown>),
  };

  // Only a flag the operator actually passed is overlaid. Every OpenAPI flag is
  // `undefined` when absent precisely so that "absent" stays distinguishable
  // from "explicitly set to a falsy value".
  const overlay: Record<string, unknown> = {
    spec: values["from-openapi"],
    base_url: values["openapi-base-url"],
    prefix: values["openapi-prefix"],
    include: values["openapi-include"],
    exclude: values["openapi-exclude"],
    headers: parseOpenapiHeaders(values["openapi-header"] as string[] | undefined),
  };
  if (values["openapi-no-deprecated"] !== undefined) {
    overlay.include_deprecated = !values["openapi-no-deprecated"];
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }

  return merged.spec ? merged : null;
}

/** The `spec` of merged settings, when they are a mapping that names one. */
function specOf(openapi: unknown): string | undefined {
  if (typeof openapi !== "object" || openapi === null) return undefined;
  const spec = (openapi as { spec?: unknown }).spec;
  return typeof spec === "string" ? spec : undefined;
}

async function runServe(values: CliValues): Promise<void> {
  const extensionsDir = values["extensions-dir"] as string | undefined;
  // A backend source may also come from the Config Bus, so the usage check has
  // to consult it — otherwise a valid `apcore-a2a.openapi.spec` in the config
  // file would be rejected for naming no flag.
  const openapi = await mergeOpenapiSettings(values);
  if (!extensionsDir && !openapi) {
    failUsage(
      "one of --extensions-dir or --from-openapi is required " +
        "(or an apcore-a2a.openapi.spec in your apcore config)",
    );
  }

  const { Registry } = await import("apcore-js");
  let registry: ApcoreRegistry;

  if (extensionsDir) {
    const resolved = resolve(extensionsDir);
    if (!existsSync(resolved)) {
      fail(`Extensions directory not found: ${resolved}`);
    }
    if (!statSync(resolved).isDirectory()) {
      fail(`Not a directory: ${resolved}`);
    }
    registry = new Registry({ extensionsDir: resolved });
  } else {
    registry = new Registry();
  }

  if (openapi) {
    const { buildOpenapiBackendFromConfig } = await import("./openapi-backend.js");
    try {
      // The merged mapping, not the raw flags: this is the one route that reads
      // `timeout` and `acknowledge_unapproved_writes`, applies the documented
      // defaults, and resolves a relative `spec` against `Config.projectRoot`
      // rather than the process CWD (FR-OAS-004 AC 5).
      registry =
        (await buildOpenapiBackendFromConfig(openapi, {
          registry,
          // `prefix` is mandatory in a mixed deployment: the scanner
          // deduplicates within one scan only and knows nothing about the
          // project modules already in the registry.
          hasOtherBackendSource: !!extensionsDir,
        })) ?? registry;
    } catch (e) {
      // The resolved spec location may appear here; the fetch headers never do.
      fail(`OpenAPI backend: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const modules = registry.list();
  if (modules.length === 0) {
    fail(`No modules discovered in ${specOf(openapi) ?? extensionsDir}`);
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
    executionTimeout: parseInt((values["execution-timeout"] as string) ?? "300", 10),
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
