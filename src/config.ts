/**
 * Config namespace registration and resolution for `apcore-a2a`.
 *
 * Mirrors the Python binding's `apcore_a2a._config`. It lives in its own module
 * rather than in `server/factory.ts` because the CLI has to read the
 * `apcore-a2a.openapi` section *before* it builds a Registry, and therefore long
 * before anything in the server stack is imported — pulling in the factory (and
 * with it express and the whole A2A SDK) just to register a namespace would put
 * the entire server on the startup path of `apcore-a2a serve --help`.
 *
 * Registration must happen from exactly ONE place: apcore's
 * `Config.registerNamespace` throws `ConfigNamespaceDuplicateError` on a second
 * call for the same name, so a second registration site would crash the process
 * at import time rather than being ignored.
 */

import { Config } from "apcore-js";

export const A2A_NAMESPACE = "apcore-a2a";
export const A2A_ENV_PREFIX = "APCORE_A2A";

/** The registered namespace defaults (stable in apcore-js >= 0.22.0). */
export const A2A_DEFAULTS: Record<string, unknown> = {
  execution_timeout: 300,
  cors_origins: [],
  explorer: false,
  metrics: false,
  push_notifications: false,
  // The OpenAPI backend's section (feature F-12) — {spec, base_url, prefix,
  // include, exclude, include_deprecated, timeout, headers,
  // acknowledge_unapproved_writes}. The first NESTED key in this namespace,
  // whose five siblings are all scalars.
  //
  // `openapi.spec` is also the FIRST path-typed key here, and apcore 0.30.0's
  // protections for path-typed keys do not reach it: `Config.pathTypedKeys()`
  // is a fixed list of apcore's own five keys and never consults a namespace
  // registered through `Config.registerNamespace` (verified against apcore
  // 0.30.0), and the PROTOCOL_SPEC §9.2.1 requirement-5 empty-value discard is
  // gated on that same set — so `APCORE_A2A_OPENAPI_SPEC=` would be treated as
  // an ordinary override to `""`, a legal relative path to every filesystem
  // API. `openapiBackend.resolveSpecLocation` owns the three rules instead.
  openapi: null,
};

/**
 * Register the `apcore-a2a` config namespace. Safe to call repeatedly.
 *
 * The already-registered case is detected rather than caught: swallowing every
 * exception here would also swallow a genuine `ConfigEnvPrefixConflictError`
 * from another package claiming `APCORE_A2A`, which is a misconfiguration the
 * operator needs to see.
 */
export function registerA2aNamespace(): void {
  if (Config.registeredNamespaces().some((ns) => ns.name === A2A_NAMESPACE)) return;
  Config.registerNamespace({
    name: A2A_NAMESPACE,
    envPrefix: A2A_ENV_PREFIX,
    defaults: A2A_DEFAULTS,
  });
}

/**
 * Resolve one `apcore-a2a` namespace setting through apcore's Config.
 *
 * Delegates to `Config.load` so that values from an apcore config file and
 * `APCORE_A2A_*` environment overrides are applied by apcore itself (namespace
 * mode), exactly like the other apcore bindings. Falls back to `fallback` when
 * the key is unset.
 */
export function getA2aSetting(key: string, fallback?: unknown): unknown {
  registerA2aNamespace();
  const value = Config.load(undefined, { validate: false }).get(
    `${A2A_NAMESPACE}.${key}`,
  );
  return value === undefined || value === null ? fallback : value;
}
