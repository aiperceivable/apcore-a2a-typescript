/**
 * OpenAPI backend — serve an OpenAPI 3.0/3.1 document as A2A Skills.
 *
 * Pipeline:
 *
 *     loadSpec -> OpenAPIScanner.scan -> [repair] -> HTTPProxyRegistryWriter.write -> Registry
 *
 * The scanner and the writer live in apcore-toolkit; this module composes them
 * and adds the two repairs the composition needs, neither of which the toolkit
 * can make on its own:
 *
 * - **FR-OAS-002 module-ID projection.** The toolkit sanitizes a derived ID into
 *   `[A-Za-z0-9_.-]`; apcore's registry accepts only
 *   `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`. Without the projection the canonical
 *   Swagger Petstore scans cleanly and registers nothing — the server starts and
 *   serves an Agent Card with zero skills, and nothing in the path raises.
 * - **FR-OAS-003 description repair.** An operation with neither `summary` nor
 *   `description` yields `""`, and `AgentCardBuilder` skips a module whose
 *   description is empty — so the operation would vanish from the Agent Card with
 *   no diagnostic.
 *
 * See `apcore-a2a/docs/features/openapi-backend.md` for the specification and
 * `conformance/fixtures/openapi_backend.json` for the shared contract.
 */

import path from "node:path";
import { Config, Registry } from "apcore-js";
import {
  HTTPProxyRegistryWriter,
  OpenAPIScanner,
  cloneModule,
  loadSpec,
  type ScannedModule,
} from "apcore-toolkit";

/**
 * One dot-separated segment of an apcore-legal module ID. apcore enforces
 * `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` at `Registry.register` and again at
 * `Executor.call`; a segment may not begin with a digit, which is why some
 * derived IDs cannot be repaired at all.
 */
export const MODULE_ID_SEGMENT = /^[a-z][a-z0-9_]*$/;

/** HTTP methods that change state. The population FR-OAS-005 warns about. */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const URL_SCHEMES = ["http://", "https://"] as const;

/**
 * The diagnostics sink.
 *
 * Injectable rather than hard-wired to `console` for two reasons: a host that
 * already owns a logger should not have this module writing past it, and the
 * conformance driver asserts the *text* of the FR-OAS-002 / FR-OAS-003 /
 * FR-OAS-005 diagnostics, which it cannot do against an unaddressable sink.
 */
export interface OpenapiBackendLogger {
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

const CONSOLE_LOGGER: OpenapiBackendLogger = {
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
  info: (message: string) => console.info(message),
};

/**
 * The fragment of apcore's `GovernanceState` this module reads.
 *
 * Both naming conventions are accepted so a duck-typed object from a test or a
 * host framework works alongside apcore's own camelCase record.
 */
export interface GovernanceStateLike {
  readonly builtinApprovalGateWired?: boolean;
  readonly builtin_approval_gate_wired?: boolean;
}
// Deliberately NOT here: any "an ACL rule requires approval" flag. apcore
// 0.30.0's GovernanceState carries no such field, and the question is
// unanswerable at this point anyway — this backend builds the Registry the
// Executor is later constructed from, so no ACL exists when the warning fires.
// FR-OAS-005 AC 6 forbids specifying this requirement in terms of one. See
// "Why there is no ACL-aware middle tier" in the feature spec.

/** Options for {@link openapiBackend}. */
export interface OpenapiBackendOptions {
  /** Where proxied requests go. Defaults to the document's `servers[0].url`. */
  baseUrl?: string;
  /** `basePathPrefix` — prepended to every derived module ID. */
  prefix?: string;
  /** Scanner include filter (regex over module IDs). */
  include?: string;
  /** Scanner exclude filter (regex over module IDs). */
  exclude?: string;
  /** When `false`, operations marked `deprecated: true` are skipped. Default `true`. */
  includeDeprecated?: boolean;
  /**
   * Headers for the **spec fetch only**. Never forwarded to proxied calls, and
   * never logged: a document is often public while the API behind it is not.
   */
  headers?: Record<string, string>;
  /**
   * Spec-fetch timeout in **SECONDS** — never the per-call proxy timeout.
   *
   * apcore-toolkit's `loadSpec` takes milliseconds (default `30_000`), so this
   * value is multiplied by 1000 at the call site. The Config Bus key is seconds
   * in all three SDKs; passing it straight through would turn a documented
   * `timeout: 30` into a 30 ms fetch timeout.
   */
  timeout?: number;
  /**
   * Passed to `HTTPProxyRegistryWriter` — the per-request credential hook.
   * apcore-toolkit >= 0.12.0 awaits the return value, so an async factory
   * (e.g. one that refreshes a rotating credential) works without a writer
   * change — matching `HTTPProxyRegistryWriter`'s own widened type.
   */
  authHeaderFactory?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Write into this registry instead of a fresh one. */
  registry?: Registry;
  /** True when an extensions directory (or another source) also populates the registry. */
  hasOtherBackendSource?: boolean;
  /** The base a relative `spec` resolves against (FR-OAS-004 rule 3). */
  projectRoot?: string;
  /** Records an explicit operator decision, suppressing FR-OAS-005's warning. */
  acknowledgeUnapprovedWrites?: boolean;
  /** Consulted only to word FR-OAS-005's warning; never to suppress it. */
  governanceState?: GovernanceStateLike | null;
  /** Scanner hook: patch an operation before extraction. */
  transformOperation?: (
    p: string,
    method: string,
    operation: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  /**
   * Caller hook: adjust the finished module. Runs **first**, before the
   * description repair and the ID projection, so the invariants those two hold
   * are unconditional whatever this returns.
   */
  transformModule?: (module: ScannedModule) => ScannedModule | null;
  /** Scanner hook: override the naming algorithm. */
  deriveModuleId?: (
    p: string,
    method: string,
    operation: Record<string, unknown>,
  ) => string | null;
  /** Diagnostics sink. Defaults to `console`. */
  logger?: Partial<OpenapiBackendLogger>;
}

/**
 * Project a toolkit-derived module ID into apcore's registry alphabet.
 *
 * Lowercase, then `-` -> `_`. Returns `null` when the result still has a segment
 * apcore would reject — such an ID cannot be repaired without *inventing* a
 * character, which is a naming decision belonging to the operator's own hook
 * rather than to a silent default. The module is dropped and reported by the
 * caller.
 */
export function projectModuleId(moduleId: string): string | null {
  const candidate = moduleId.toLowerCase().replace(/-/g, "_");
  if (candidate === "") return null;
  if (!candidate.split(".").every((segment) => MODULE_ID_SEGMENT.test(segment))) {
    return null;
  }
  return candidate;
}

/** The first segment of a projected ID that apcore would still reject. */
function offendingSegment(moduleId: string): string {
  const candidate = moduleId.toLowerCase().replace(/-/g, "_");
  return (
    candidate.split(".").find((segment) => !MODULE_ID_SEGMENT.test(segment)) ?? candidate
  );
}

/** The minimum surface {@link synthesizeDescription} reads off a scanned module. */
export interface DescribableModule {
  readonly moduleId?: string;
  readonly metadata?: Record<string, unknown> | null;
}

/**
 * Build a `{METHOD} {path}` description for an undocumented operation.
 *
 * Uses the `http_method` / `url_path` metadata keys `HTTPProxyRegistryWriter`
 * already requires, so the value is factual and stable across scans of the same
 * document. Deliberately terse so it reads as a placeholder rather than as
 * documentation.
 */
export function synthesizeDescription(module: DescribableModule): string {
  const metadata = module.metadata ?? {};
  // String-only, never a coercion. `String(123)` would put a bare number on the
  // PUBLIC Agent Card as if it were an HTTP method, and `String(false)` would
  // put "FALSE" there — a method that does not exist, published to a route
  // served without authentication and built to be crawled. A non-string here
  // means the metadata is malformed — reachable from a caller's own
  // `transformOperation` hook or a vendor extension — and the honest answer is
  // to treat the field as absent and fall through the chain below. Rust's
  // `as_str()` already did this; TypeScript and Python were the two that coerced.
  const rawMethod = metadata.http_method;
  const rawPath = metadata.url_path;
  const method = typeof rawMethod === "string" ? rawMethod.trim().toUpperCase() : "";
  const urlPath = typeof rawPath === "string" ? rawPath.trim() : "";
  if (method && urlPath) return `${method} ${urlPath}`;
  if (method) return method;
  return urlPath || String(module.moduleId ?? "") || "operation";
}

/**
 * The base a relative `spec` resolves against (FR-OAS-004 rule 3).
 *
 * `Config.projectRoot` is apcore 0.30.0's public accessor. It reports a base and
 * applies nothing, which is exactly the division of labour this key needs: the
 * adapter owns the resolution because `Config.pathTypedKeys()` never reaches a
 * consumer namespace.
 */
export function resolveProjectRoot(explicit?: string | null): string {
  if (explicit) return explicit;
  try {
    const root = Config.load(undefined, { validate: false }).projectRoot;
    if (root) return root;
  } catch {
    // A missing or unloadable apcore config is not fatal here; the CWD is the
    // same answer `Config.projectRoot` gives when no config file was found.
  }
  return process.cwd();
}

/**
 * Resolve `apcore-a2a.openapi.spec` (FR-OAS-004).
 *
 * apcore 0.30.0 declared the closed set of path-typed configuration keys and the
 * base a relative one resolves against, but `Config.pathTypedKeys()` is a fixed
 * list of apcore's own keys and never consults a namespace registered through
 * `Config.registerNamespace` — verified against apcore 0.30.0. The §9.2.1
 * requirement-5 empty-value discard is gated on that same set, so
 * `APCORE_A2A_OPENAPI_SPEC=` would otherwise become an ordinary override to `""`,
 * a legal relative path to every filesystem API and never the one an operator
 * meant. This binding therefore owns the three rules rather than inheriting them.
 *
 * 1. A value beginning `http://` / `https://` is a URL, used verbatim — never
 *    path-resolved, never made absolute.
 * 2. A set-but-empty value is discarded with a WARNING and the caller falls
 *    through to the next configuration tier. It is never joined to a base, which
 *    would silently yield the project root.
 * 3. A relative path resolves against `Config.projectRoot` — not the process CWD,
 *    and not the document's own directory.
 *
 * @returns the URL unchanged, an absolute path, the already-parsed document, or
 *   `null` when the value was empty and the caller should fall through.
 */
export function resolveSpecLocation(
  spec: unknown,
  options: { projectRoot?: string | null; logger?: { warn(message: string): void } } = {},
): unknown {
  if (spec === null || spec === undefined) return null;
  // An already-parsed document. Nothing to resolve.
  if (typeof spec !== "string") return spec;

  if (spec.trim() === "") {
    (options.logger ?? CONSOLE_LOGGER).warn(
      "apcore-a2a.openapi.spec is set but empty; discarding it and falling through to " +
        "the next configuration tier. An empty value is not a path.",
    );
    return null;
  }
  if (URL_SCHEMES.some((scheme) => spec.startsWith(scheme))) return spec;
  if (path.isAbsolute(spec)) return spec;
  return path.resolve(resolveProjectRoot(options.projectRoot), spec);
}

/** `servers[0].url`, when it is a usable absolute URL. */
function documentServerUrl(document: Record<string, unknown>): string | undefined {
  const servers = document.servers;
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const first = servers[0] as { url?: unknown } | undefined;
  const url = first?.url;
  if (typeof url !== "string") return undefined;
  return URL_SCHEMES.some((scheme) => url.startsWith(scheme)) ? url : undefined;
}

/**
 * Every module ID in `registry`, hidden ones included.
 *
 * The `catch` is narrow on purpose, and only for the compatibility case it is
 * named for: a `TypeError` from an older `Registry` whose `list` does not accept
 * the `visibility` option. **Every other failure propagates.** Swallowing them
 * and returning `[]` silently disables the FR-OAS-006 collision preflight — with
 * an empty `existing` set no collision is ever detected, so a duplicate arrives
 * instead as a failed `WriteResult`, which is exactly the partial-registry
 * failure the preflight exists to close: a skill the document advertises, absent
 * from the card, with one log line as the only notice. Python catches only
 * `TypeError` here and Rust's `Registry::list` is infallible.
 */
function registryIds(registry: Registry): string[] {
  try {
    return registry.list({ visibility: ["public", "hidden"] }) ?? [];
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return registry.list() ?? [];
  }
}

function httpMethodOf(module: ScannedModule): string {
  const metadata = (module.metadata ?? {}) as Record<string, unknown>;
  return String(metadata.http_method ?? "").toUpperCase();
}

/**
 * FR-OAS-005 — the unapproved-write warning.
 *
 * The toolkit infers annotations from the HTTP method alone and never infers
 * `requiresApproval`, so every scanned module arrives with it `false`: a
 * `POST /charges` that moves money is annotated exactly like a `POST /echo`.
 *
 * This reports the **absence of a gate, never the presence of protection** — the
 * rule apcore states on `GovernanceState.unprotectedControlSurface`: *a wired ACL
 * that permits every call still yields false*. So an attached ACL never
 * suppresses this warning; it only softens the wording when at least one rule
 * carries `approval: required`, because whether that rule's `targets` cover these
 * modules is a match-relation question this cannot decide.
 *
 * The message names the public Agent Card because that is the exposure that
 * distinguishes the A2A binding: `/.well-known/agent-card.json` is auth-exempt by
 * design and A2A clients are built to crawl it.
 */
function warnUnapprovedWrites(
  modules: readonly ScannedModule[],
  options: {
    acknowledge: boolean;
    governanceState?: GovernanceStateLike | null;
    log: OpenapiBackendLogger;
  },
): void {
  if (options.acknowledge) return;

  const unapproved = modules.filter(
    (module) =>
      WRITE_METHODS.has(httpMethodOf(module)) && !module.annotations?.requiresApproval,
  );
  if (unapproved.length === 0) return;

  const methods = [...new Set(unapproved.map(httpMethodOf))].sort();
  const ids = unapproved
    .map((module) => module.moduleId)
    .sort()
    .slice(0, 10)
    .join(", ");

  const state = options.governanceState;
  const gateWired = state?.builtinApprovalGateWired ?? state?.builtin_approval_gate_wired;

  // TWO tiers, never three. See the note on GovernanceStateLike above.
  let lead: string;
  if (gateWired === false) {
    // Escalated: under the `internal`, `testing` and `minimal` strategies the
    // approval gate is not in the pipeline at all, so neither a module-level
    // annotation nor an ACL rule's `approval: required` would fire.
    lead =
      "the approval gate is NOT in the execution pipeline under the active strategy, " +
      "so neither a module annotation nor an ACL rule's `approval: required` would fire for";
  } else {
    // "module-level" is normative: the backend can speak to the annotation and
    // must not appear to speak to the deployment's governance, which it cannot
    // see from here.
    lead = "no module-level approval requirement is declared for";
  }

  options.log.warn(
    `apcore-a2a: ${lead} ${unapproved.length} scanned write operation(s) ` +
      `(${methods.join("/")}). They will be advertised on the PUBLIC Agent Card at ` +
      "/.well-known/agent-card.json, which is served without authentication. Configure " +
      "an ACL rule carrying `approval: required`, set requiresApproval via a " +
      "transformModule hook, or set apcore-a2a.openapi.acknowledge_unapproved_writes: " +
      `true to record this as intended. Affected: ${ids}`,
  );
}

/**
 * Build an apcore `Registry` from an OpenAPI 3.0/3.1 document.
 *
 * `spec` is a URL, a filesystem path (resolved per FR-OAS-004), or an
 * already-parsed document object. `timeout` is the **spec-fetch** timeout in
 * seconds, never the per-call proxy timeout — the two are different concerns.
 *
 * Never returns a partially-populated registry: the collision preflight and
 * every validation run before the first write.
 */
export async function openapiBackend(
  spec: unknown,
  options: OpenapiBackendOptions = {},
): Promise<Registry> {
  const log: OpenapiBackendLogger = { ...CONSOLE_LOGGER, ...options.logger };

  // Checked FIRST, before any fetch or scan: the scanner deduplicates within one
  // scan only and knows nothing about modules already in the registry, so a
  // misconfiguration here must fail without a network round trip.
  if (options.hasOtherBackendSource && !options.prefix) {
    throw new Error(
      "apcore-a2a.openapi.prefix is required when another backend source is also " +
        "configured: without it a derived module ID can collide with a project module ID.",
    );
  }

  // --- 1. Locate and load ---------------------------------------------------
  const resolved = resolveSpecLocation(spec, {
    projectRoot: options.projectRoot,
    logger: log,
  });
  if (resolved === null) {
    throw new Error("apcore-a2a.openapi.spec is required and resolved to nothing.");
  }
  const document =
    typeof resolved === "string"
      ? await loadSpec(resolved, {
          headers: options.headers,
          // The Config Bus key is SECONDS; `LoadSpecOptions.timeout` is
          // MILLISECONDS. Converting here is the whole of the fix — passing the
          // seconds value straight through turns a documented `timeout: 30` into
          // a 30 ms fetch timeout.
          timeout: Math.round((options.timeout ?? 30) * 1000),
        })
      : (resolved as Record<string, unknown>);

  // --- 2. Scan, repairing each module on the way out ------------------------
  const dropped: Array<{ derivedId: string; segment: string }> = [];
  const synthesized: string[] = [];

  const repair = (scanned: ScannedModule): ScannedModule | null => {
    // A caller's own hook runs FIRST so the two invariants below hold
    // unconditionally, whatever it returns.
    let module: ScannedModule | null = scanned;
    if (options.transformModule) {
      module = options.transformModule(module);
      if (module === null || module === undefined) return null;
    }

    // FR-OAS-003: repair the description before the module can reach a card
    // filter that would silently drop it.
    const wasSynthesized = !(module.description ?? "").trim();
    if (wasSynthesized) {
      module = cloneModule(module, { description: synthesizeDescription(module) });
    }

    // FR-OAS-002, LAST: so "every registered module ID is apcore-legal" holds
    // unconditionally. Runs before the scanner's own `deduplicateIds`, because
    // lowercasing can CREATE a collision the document did not have —
    // `listPets` and `listpets` are two operations to OpenAPI and one module ID
    // to apcore, and projecting afterwards would register one and lose the other
    // with no warning.
    const projected = projectModuleId(module.moduleId);
    if (projected === null) {
      dropped.push({
        derivedId: module.moduleId,
        segment: offendingSegment(module.moduleId),
      });
      return null;
    }
    if (projected !== module.moduleId) {
      module = cloneModule(module, { moduleId: projected });
    }

    // Report the PROJECTED id: it is the one that reaches the Agent Card, and a
    // diagnostic naming the pre-projection id sends the operator looking for a
    // skill that does not exist.
    if (wasSynthesized) synthesized.push(projected);
    return module;
  };

  const modules = new OpenAPIScanner().scan(document, {
    include: options.include,
    exclude: options.exclude,
    basePathPrefix: options.prefix,
    includeDeprecated: options.includeDeprecated ?? true,
    transformOperation: options.transformOperation,
    deriveModuleId: options.deriveModuleId,
    transformModule: repair,
  });

  // A `transformModule` returning null drops the module SILENTLY, so reporting
  // is this module's responsibility and cannot be delegated to the scanner.
  for (const drop of dropped) {
    log.warn(
      `apcore-a2a: skipping OpenAPI operation '${drop.derivedId}' — the derived module ` +
        `ID has a segment ('${drop.segment}') apcore's registry cannot accept (it must ` +
        "match ^[a-z][a-z0-9_]*$), and it cannot be repaired without inventing an ID. " +
        "Supply a deriveModuleId or transformModule hook to name this operation yourself.",
    );
  }
  for (const module of modules) {
    for (const warning of module.warnings ?? []) {
      log.warn(`apcore-a2a: ${module.moduleId}: ${warning}`);
    }
  }
  if (modules.length === 0) {
    log.warn(
      "apcore-a2a: the OpenAPI document produced no registrable modules; the Agent Card " +
        "will have no skills.",
    );
  }
  if (synthesized.length > 0) {
    log.info(
      `apcore-a2a: ${synthesized.length} of ${modules.length + dropped.length} scanned ` +
        'operations had no summary or description; a "{METHOD} {path}" description was ' +
        "synthesized so they appear on the Agent Card. Affected: " +
        [...synthesized].sort().join(", "),
    );
  }

  // --- 3. Collision preflight -----------------------------------------------
  // Full-set, before the first write. Toolkit writers report per-module
  // WriteResults and never abort, so without this a duplicate would arrive as a
  // failed WriteResult, get logged and skipped, and leave a partial registry: a
  // skill the document advertises, absent from the card, with one log line as
  // the only notice.
  const target = options.registry ?? new Registry();
  const existing = new Set(registryIds(target));
  const collisions = [
    ...new Set(modules.map((m) => m.moduleId).filter((id) => existing.has(id))),
  ].sort();
  if (collisions.length > 0) {
    throw new Error(
      "OpenAPI-derived module IDs collide with modules already in the registry: " +
        `${collisions.join(", ")}. Nothing was registered. Set apcore-a2a.openapi.prefix ` +
        "to namespace them.",
    );
  }

  // --- 4. Base URL ----------------------------------------------------------
  const baseUrl = options.baseUrl ?? documentServerUrl(document);
  if (!baseUrl) {
    throw new Error(
      "No base_url: the document has no usable absolute servers[0].url, so every proxied " +
        "call would resolve against an unknown host. Set apcore-a2a.openapi.base_url.",
    );
  }

  // --- 5. Write -------------------------------------------------------------
  const writer = new HTTPProxyRegistryWriter({
    baseUrl,
    authHeaderFactory: options.authHeaderFactory,
  });
  for (const result of writer.write([...modules], target)) {
    if (result.verificationError) {
      log.error(
        `apcore-a2a: ${result.moduleId} failed to register as an HTTP proxy: ` +
          result.verificationError,
      );
    }
  }

  warnUnapprovedWrites(modules, {
    acknowledge: options.acknowledgeUnapprovedWrites ?? false,
    governanceState: options.governanceState,
    log,
  });
  return target;
}

/**
 * Build the backend from an `apcore-a2a.openapi` Config Bus section.
 *
 * The raw Config Bus value is a plain object (from `apcore.yaml` or
 * `APCORE_A2A_OPENAPI_*` env vars) in snake_case, not the camelCase options
 * {@link openapiBackend} takes, so this is the one place that translates between
 * them.
 *
 * Returns `null` when the section is absent or falsy, so a caller can treat "no
 * OpenAPI configured" as an ordinary outcome.
 *
 * `authHeaderFactory` is deliberately not read from the section: it is a
 * callable, and a value sourced from YAML/JSON/env can never carry one.
 */
export async function buildOpenapiBackendFromConfig(
  openapiConfig: unknown,
  options: {
    registry?: Registry;
    hasOtherBackendSource?: boolean;
    governanceState?: GovernanceStateLike | null;
    logger?: Partial<OpenapiBackendLogger>;
  } = {},
): Promise<Registry | null> {
  if (!openapiConfig) return null;
  if (typeof openapiConfig !== "object" || Array.isArray(openapiConfig)) {
    throw new Error("apcore-a2a.openapi must be a mapping.");
  }
  const cfg = openapiConfig as Record<string, unknown>;

  const spec = cfg.spec;
  if (spec === null || spec === undefined || (typeof spec === "string" && !spec.trim())) {
    throw new Error("apcore-a2a.openapi.spec is required.");
  }

  return openapiBackend(spec, {
    baseUrl: typeof cfg.base_url === "string" ? cfg.base_url : undefined,
    prefix: typeof cfg.prefix === "string" ? cfg.prefix : undefined,
    include: typeof cfg.include === "string" ? cfg.include : undefined,
    exclude: typeof cfg.exclude === "string" ? cfg.exclude : undefined,
    includeDeprecated:
      typeof cfg.include_deprecated === "boolean" ? cfg.include_deprecated : true,
    headers: cfg.headers as Record<string, string> | undefined,
    // Seconds here, milliseconds at the `loadSpec` boundary.
    timeout: typeof cfg.timeout === "number" ? cfg.timeout : 30,
    registry: options.registry,
    hasOtherBackendSource: options.hasOtherBackendSource ?? false,
    // Resolve the project root HERE rather than leaving it to the default: this
    // is the route most deployments use, and leaving it unset is exactly what
    // makes a relative `spec` resolve against the process CWD instead of
    // `Config.projectRoot`, contradicting FR-OAS-004 rule 3.
    projectRoot: resolveProjectRoot(null),
    acknowledgeUnapprovedWrites:
      typeof cfg.acknowledge_unapproved_writes === "boolean"
        ? cfg.acknowledge_unapproved_writes
        : false,
    governanceState: options.governanceState,
    logger: options.logger,
  });
}
