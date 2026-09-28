# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Adopts apcore-toolkit 0.13.0, whose `OpenAPIScanner` now emits every `moduleId` in apcore's
Canonical ID alphabet itself, and retires this binding's own module-ID projection (FR-OAS-002)
to match. Tracks the `apcore-a2a` spec's `openapi_backend.json` contract 2.0.

Suite: 464 tests (was 454), 0 skipped; `tsc --noEmit`, `pnpm build` and the pre-commit hooks
clean.

### Changed — BREAKING

- **OpenAPI-derived module IDs — and therefore A2A skill IDs — change for every camelCase or
  hyphenated `operationId` and path.** The toolkit splits camelCase into snake_case words where
  this binding's projection only lowercased: `listPets` → `list_pets` (was `listpets`); under
  `prefix: "petstore"`, `petstore.list_pets` (was `petstore.listpets`); and camelCase path
  parameters likewise (`GET /pets/{petId}` → `pets.pet_id.get`, was `pets.petid.get`). A
  `prefix` is normalised with the rest of the ID (`Pet-Store` → `pet_store.…`). IDs that were
  already lowercase and legal are unchanged. **Migration:** ACL rules (`targets`), bindings, and
  `include` / `exclude` patterns keyed on the old IDs must be updated — the scanner's filters
  match the emitted, normalised ID (`^read_audit_log$`, not `readAuditLog`). The recommended
  prefixed catch-all deny rule (`petstore.*`) keeps holding, but an allow-list of old operation
  names now fails closed until it is updated. Clients that call skills by ID must use the new IDs.
- **Required `apcore-toolkit` floor raised to 0.13.0** (was `>=0.12.0`); `pnpm-lock.yaml`
  refreshed.
- **FR-OAS-002 is now a skip policy, applied after `scan`.** `openapiBackend` no longer rewrites
  IDs: it registers the ID the scanner emitted. It still skips a module whose emitted ID apcore's
  registry would reject — the one case the toolkit deliberately does not repair, a segment that
  begins with a digit (`/v1/2fa` → `v1.2fa.get`), or an empty ID from a hook — with the same
  WARNING as before, now checked on the IDs `scan` returns instead of inside `transformModule`.
  A hook returning `MyThing` is normalised by the toolkit to `my_thing` and registers (the old
  in-hook projection made it `mything`; a legality check left there would have skipped it). The
  toolkit's own legality warning for a skipped module is not re-emitted beside the skip line.
  The caller's `transformModule` is now handed to the scanner as it is, so it still runs first.
- **The FR-OAS-003 description repair runs on the modules `scan` returns**, still after the
  caller's `transformModule` hook, so the synthesis INFO line names the IDs actually emitted —
  including a deduplicated `…_2`, which the in-hook repair, running before the scanner's
  deduplication, reported under the pre-deduplication ID (`list_pets` twice, never
  `list_pets_2`).

### Deprecated

- **`projectModuleId`** (`@deprecated`). apcore-toolkit >= 0.13 emits IDs in apcore's alphabet,
  so the projection is no longer needed and nothing in this package calls it. Still exported with
  its behaviour unchanged; it will be removed in a later minor release. It does not reproduce the
  toolkit's naming (`listPets` → `listpets`, not `list_pets`), so do not use it to predict the ID
  a module registers under. `MODULE_ID_SEGMENT` is unaffected — the skip policy uses it.

### Fixed

- **An operation removed by `include` / `exclude` was still reported as description-synthesized.**
  The repair ran inside the scanner's `transformModule` hook, which runs before the scanner's
  own filters, so the FR-OAS-003 INFO line named operations that never registered and counted
  them against a denominator that excluded them (`2 of 1 scanned operations`). The feature spec
  already required the opposite ("an operation excluded by configuration is never synthesized for
  and never reported"); running the repair after `scan` makes it true.

### Tests

- The conformance driver reads `openapi_backend.json` contract 2.0: re-pinned IDs; three new
  cases (`projection_hook_output_normalised_not_skipped`,
  `description_synthesis_report_names_the_emitted_id`,
  `description_not_synthesized_for_excluded_operation`); the fixture's named `hooks` (an unknown
  hook name fails the case); `expected_no_error_logs`; and `expected_synthesis_report`. The
  synthesis assertions are now scoped to the synthesis INFO line (they searched the whole INFO
  buffer), and the skipped-operation assertion now requires the offending segment to be named
  apart from the ID on a WARNING line (it searched every level, and `2fa` is a substring of
  `v1.2fa.get`).
- New regressions: `openapiBackend` never calls `projectModuleId`; an illegal hook-returned ID is
  skipped whatever its shape (including the empty ID); a skipped module reaches no later
  diagnostic (no synthesis, no FR-OAS-005 count, the zero-modules warning fires, nothing at
  ERROR); a caller hook's `Pet-Store.ListPets` registers as `pet_store.list_pets` with its
  cleared description repaired.

## [0.8.0] - 2026-09-24

Minor release, version-aligned with the Python and Rust SDKs. Raises the required floor to
`apcore-js` 0.31.0 and `apcore-toolkit` 0.12.0, and fixes a task-execution-timeout defect found
while reviewing what those two releases changed. `apcore-js` 0.31.0 is two joined audit cycles
(`PROTOCOL_SPEC` v1.37.0 → v1.59.0) settling 54 cross-language divergences; `apcore-toolkit`
0.12.0 adds Device Authorization Flow (unused here) and fixes a `$ref` sibling-key
credential-disclosure bug in its own schema resolver (this package's OpenAPI Backend delegates
`$ref` resolution to apcore-toolkit's `deepResolveRefs` unmodified, so it inherits that fix with
no code change of its own).

Suite: 453 tests (unchanged), `tsc --noEmit` clean, `eslint` 0 errors, `tsc` build clean.

### Fixed

- **`ApCoreAgentExecutor` silently dropped the task's execution timeout onto apcore's floor.**
  `src/server/executor.ts` seeded the deadline via `data[CTX_GLOBAL_DEADLINE]`
  (`Date.now() + executionTimeoutMs`, milliseconds) instead of `Context.create`'s own
  `globalDeadline` parameter — a workaround for a bug in `apcore-js` itself, fixed upstream in
  0.31.0 (spec decisions D-99/D-100/D-101): `BuiltinContextCreation` now reads only the
  first-class `Context.globalDeadline` field (epoch **seconds**) and no longer consults
  `data[CTX_GLOBAL_DEADLINE]` at all. Once the floor moved, this package's workaround went from
  "necessary" to silently inert — apcore's pipeline would fall back to its own config-level
  default deadline (or none) instead of the task's actual `executionTimeout`, with no error.
  Fixed to pass `globalDeadline` as `Context.create`'s sixth positional argument, in epoch
  seconds. The host-side `Promise.race` wall-clock guard in the streaming path (`A-D-13`,
  further down the same file) is a separate, already-correct mechanism and needed no change.

- **`OpenAPIBackendOptions.authHeaderFactory`'s type was narrower than what
  `HTTPProxyRegistryWriter` now accepts.** apcore-toolkit 0.12.0 widened
  `HTTPProxyRegistryWriter.authHeaderFactory` to `() => Record | Promise<Record>` (awaited, so a
  rotating credential can refresh inside it). This package's own `authHeaderFactory` option type
  in `src/openapi-backend.ts`, passed straight through to the writer, was still typed
  synchronous-only, which would reject a valid async factory at the type level even though the
  writer underneath now supports one. Widened to match.

### Changed — dependency floor

- **Required `apcore-js` floor raised to 0.31.0** (was `>=0.30.0`) and **required
  `apcore-toolkit` floor raised to 0.12.0** (was `>=0.11.1`). Grepped this package's own
  `apcore-js`/`apcore-toolkit` surface (`Context`/`Identity`/`CancelToken` via `Context.create`,
  `Registry`, `Module`, `executorAcl`/`checkAccess`, `Executor.governanceState()`,
  `deepResolveRefs`, `OpenAPIScanner`/`loadSpec`/`HTTPProxyRegistryWriter`) against both
  changelogs' breaking-change sections: the D-103 null-identity fix and the `sys_modules`
  per-group-flag enforcement change are both apcore-rust-only /
  already-matched-by-this-binding's-defaults respectively and needed nothing here; the two
  fixes above were the only real findings.

## [0.7.0] - 2026-09-07

Minor release, version-aligned with the Python and Rust SDKs. Ships the **OpenAPI Backend**
(feature F-12) on the `apcore-js >=0.30.0` / `apcore-toolkit >=0.11.1` floor 0.6.1 already
raised — apcore-toolkit 0.11.0 is what shipped the OpenAPI Scanner the feature is built on.

Suite: 453 tests (was 388), `tsc --noEmit` clean, `eslint` 0 errors.

### Added

- **`src/openapi-backend.ts`** — `openapiBackend()`, plus `projectModuleId`,
  `resolveSpecLocation`, `synthesizeDescription` and `buildOpenapiBackendFromConfig`, all
  re-exported from the package root. Point it at an OpenAPI 3.0/3.1 document and every
  operation becomes an A2A Skill, proxied over HTTP to the API that published it, with no
  apcore project on the other end.

  The pipeline is `loadSpec → OpenAPIScanner.scan → HTTPProxyRegistryWriter.write →
  Registry`, all already-shipped apcore-toolkit code; everything downstream is the adapter
  that already serves an extensions directory, unmodified. See
  `apcore-a2a/docs/features/openapi-backend.md`.

- **Two repairs the composition cannot work without.** `FR-OAS-002`: apcore-toolkit derives
  module IDs into `[A-Za-z0-9_.-]` while apcore's `Registry` accepts only
  `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` — measured against apcore 0.30.0 / apcore-toolkit
  0.11.1, the canonical Swagger Petstore scans cleanly, registers **nothing**, and yields an
  Agent Card with zero skills without raising anywhere. A derived ID is lowercased and its
  hyphens become underscores; one that still has an unusable segment (`2fa`) is dropped and
  reported at WARN naming both the ID and the segment, because the projection runs inside the
  scanner's `transformModule` hook and a hook returning `null` drops the module *silently*.
  `FR-OAS-003`: an operation with neither `summary` nor `description` yields `""`, and
  `AgentCardBuilder` skips empty-description modules, so undocumented operations vanished
  from the card with no diagnostic; a `{METHOD} {path}` description is synthesized instead
  and the affected modules are named at INFO — by their **post-projection** IDs, since those
  are the ones that reach the card.

  Two orderings are normative and asserted: a caller's own `transformModule` hook runs
  first and the projection last, and the projection runs before the scanner's own
  `deduplicateIds`, because lowercasing can *create* a collision the document did not have
  (`listPets` / `listpets`).

- **`FR-OAS-005` unapproved-write warning.** The scanner never infers `requiresApproval` for
  any HTTP method, and the 0.6.0 public-card filter subtracts only ACL-denied and
  approval-gated skills — so a scanned `POST /charges` is advertised on the unauthenticated
  `/.well-known/agent-card.json`. The warning names that exposure, and is **never**
  suppressed by the presence of an ACL (it reports the absence of a gate, never the presence
  of protection), only by having nothing to warn about, by a module declaring
  `requiresApproval` itself, or by an explicit `acknowledge_unapproved_writes`.

- **CLI:** `--from-openapi`, `--openapi-base-url`, `--openapi-prefix`, `--openapi-include`,
  `--openapi-exclude`, `--openapi-header` (repeatable `KEY:VALUE`, spec fetch only) and
  `--openapi-no-deprecated`. `--extensions-dir` is no longer required on its own; one of it,
  `--from-openapi`, or an `apcore-a2a.openapi.spec` in the apcore config must be given. An
  extensions directory alongside an OpenAPI source requires a prefix, from either route.

- **Config:** an `apcore-a2a.openapi` namespace default, the namespace's first nested key and
  its first path-typed one. apcore 0.30.0's protections for path-typed keys do not reach a
  consumer namespace — `Config.pathTypedKeys()` is a fixed list of apcore's own five keys and
  never consults a namespace registered through `Config.registerNamespace` — so
  `resolveSpecLocation` owns the three rules instead: a URL verbatim, a set-but-empty value
  discarded with a warning, a relative path resolved against `Config.projectRoot`.

- **`src/config.ts`** — `registerA2aNamespace()` and `getA2aSetting()`, the Python binding's
  `_config` module in TypeScript. The namespace registration moves here from
  `server/factory.ts` because the CLI must read `apcore-a2a.openapi` before it has a Registry
  to serve, and importing the factory (with express and the A2A SDK behind it) merely to
  register a namespace would put the whole server on the startup path of `serve --help`.
  Registration stays a single site by necessity: a second `Config.registerNamespace` for the
  same name throws `ConfigNamespaceDuplicateError`, which at module scope is a crash on
  import, so the function detects the already-registered case rather than catching it (a
  blanket catch would also swallow a real `APCORE_A2A` env-prefix conflict).

- 46 new conformance tests (`tests/conformance/openapi-backend.test.ts`) against the shared
  corpus in `apcore-a2a/conformance/fixtures/openapi_backend.json`, including the fixture's
  `card_cases` — the Python runner does not assert those, and here they are checkable against
  the real `buildPublicCard` / `buildExtendedCard`. Plus 10 in `tests/cli.test.ts`: 4 for
  `parseOpenapiHeaders` and 6 for the Config Bus wiring below, which drive apcore's real
  `Config` against a temp `apcore.yaml` rather than a stubbed accessor.

### Fixed

- **The `apcore-a2a.openapi` Config Bus section was read by nothing.**
  `buildOpenapiBackendFromConfig` had no caller anywhere in `src/`, so the section the feature
  spec documents as a first-class surface — and SRS FR-OAS-004 AC 5 states a requirement about
  — never reached a running server. `timeout`, `include`, `exclude` and
  `acknowledge_unapproved_writes` have no CLI flag either, so those four keys were unreachable
  through any live path at all. `serve` now merges the section with the flags and hands the
  result to `buildOpenapiBackendFromConfig`, which also brings the seconds→milliseconds
  `timeout` conversion and the `Config.projectRoot` resolution onto the CLI route.

  The merge is **per key, not per source**: a `--openapi-prefix` alongside a config-declared
  `spec` takes effect, rather than the flag being silently dropped because the config named
  the spec — the shape of the apcore-mcp `--openapi-header` defect filed upstream as
  apcore-mcp-rust#8. The "no backend source" usage check consults the Config Bus too, so a
  config file naming a `spec` starts a server with no flag at all.

- **`--openapi-no-deprecated` lost its `default: false`.** With it, *not passing* the flag
  overwrote a config `include_deprecated: false` with `true` — an unpassed flag silently
  reversing a setting the operator wrote. It is now `undefined` when absent (the parseArgs
  equivalent of the Python binding's `default=None`) and only overlaid when actually passed.
  `parseCliArgs` is split out of `main` so both halves of that contract are testable without
  starting a server.

- **The FR-OAS-005 warning carried a third wording tier that SRS FR-OAS-005 AC 6 forbids.**
  `GovernanceStateLike` declared `approvalRulePresent` / `approval_rule_present` and the
  warning had an "an ACL approval path exists but whether its targets cover these operations
  cannot be decided here" lead. apcore 0.30.0's `GovernanceState` carries no such field — and,
  the reason the tier was struck from the spec in the first place, the question is unanswerable
  at this point regardless: the backend builds the `Registry` the `Executor` is later
  constructed from, so no ACL exists when the warning fires. Unlike Python and Rust, which
  type against apcore's concrete record, this SDK accepts a duck-typed governance object, so
  the branch was genuinely reachable here. Removed, with a comment naming the requirement so
  it is not reintroduced.

  The base wording also moves from "no approval requirement is configured for" to "no
  **module-level** approval requirement is declared for", matching Python and Rust. The
  distinction is normative: the backend can speak to the module annotation and must not appear
  to speak to the deployment's governance, which it cannot see from where it runs.

- **`registryIds` swallowed every exception and returned `[]`, silently disabling the
  FR-OAS-006 collision preflight.** Nested try/catch ending in `return []` meant an empty
  `existing` set, so no collision was ever detected and a duplicate arrived instead as a failed
  `WriteResult` — the exact partial-registry failure FR-OAS-006 exists to close: a skill the
  document advertises, absent from the card, one log line as the only notice. The catch is now
  narrowed to the older-signature `TypeError` it was actually for; anything else propagates.
  Dormant against apcore-js 0.30.0, whose `list({visibility})` works — this is about the
  failure mode, not a live break. Python caught only `TypeError` already; Rust is infallible.

- **A whitespace-only header key was accepted.** `indexOf(":") <= 0` rejects `":v"` but accepts
  `" :v"` — the colon is at index 1 — and the `.trim()` that follows then produced an empty
  header name. Python checks `not key.strip()` and Rust `key.trim().is_empty()`; both rejected
  it. The existing behaviour of never echoing the offending value is unchanged: that is a
  security requirement in the spec and this SDK already got it right.

- **`synthesizeDescription` coerced non-string metadata.** `String(x ?? "")` turned
  `http_method: 123` into `"123"` and `http_method: false` into `"FALSE"` — a method that does
  not exist, published to the **public** Agent Card, a route served without authentication and
  built to be crawled. A non-string means the metadata is malformed (reachable from a caller's
  own `transformOperation` hook or a vendor extension) and the field is now treated as absent.
  Rust's `as_str()` always did this; Python has been changed to match, so all three agree.

- **The three CLIs disagreed on the exit code for a usage fault, and Rust disagreed with
  itself.** Measured before the fix: Python exited `2` for a usage fault and `1` for a
  configuration fault — correct; TypeScript collapsed everything onto `1`; and Rust exited `2`
  for `--bogus` (clap caught it) but `1` for a missing backend source (its own check did) — the
  same class of mistake, two codes, decided by which layer noticed first.

  All three now implement both tiers: **`2` the command line is wrong** (no backend source, an
  unknown flag, a flag missing its value, a malformed `--openapi-header`) and **`1` the
  environment it named is wrong** (missing directory, zero modules, unresolvable spec, missing
  auth key). The distinction is actionable — a supervisor may retry `1` and must never retry
  `2` — and `2` is what argparse, clap and GNU getopt all use, so the bindings agree with the
  tools around them as well as with each other.

  This SDK routes usage faults through a new `failUsage()`; `fail()` keeps `1`.

- **A misspelled flag was silently ignored, and the failure widened what the public Agent
  Card published.** `parseArgs` runs with `strict: false`, and node's tolerance extends to
  *unknown* flags — where it is not tolerance but silence. Measured with a one-letter typo:
  `--openapi-exclde 'secret.*'` put `"openapi-exclde": true` in `values` and `"secret.*"` in
  `positionals`, so the exclusion did not apply and every operation it was meant to hold back
  was scanned, registered and published to the **public** Agent Card — a route served without
  authentication and built to be crawled. The server started and reported success.

  Python's argparse and Rust's clap both refuse the same argv and exit `2`, so the tolerant
  behaviour was never portable: only a TypeScript-only deployment could have depended on it,
  and that same command was already failing in the other two bindings.

  Fixed with an explicit unrecognized-argument check rather than `strict: true`. `strict:
  false` is kept on purpose — it is what lets this CLI tolerate `--metrics=x` for a boolean and
  a repeat of a non-`multiple` option, both of which `strict: true` would turn into throws —
  so the check is scoped to the case that is actually dangerous. A stray positional is refused
  too, because that is where a misspelled flag's *value* lands.

### Fixed (conformance harness)

- **The conformance runner could pass vacuously.** It read each fixture group through
  `fixture?.group ?? []`, so renaming a group upstream made the loop iterate zero cases and
  report success. Measured by renaming `test_cases`: this file dropped from 46 passing tests to
  33 **with no failure**, while apcore-a2a-python failed loudly on the same mutation because it
  indexes the key directly. A `cases()` helper now throws on an absent or empty group. Skipping
  the whole suite when the spec repo is not checked out remains a separate, legitimate case.

### Notes

Four defects found in apcore-mcp's implementations are deliberately not inherited, and each
has a test that fails if it is reintroduced:

- **`loadSpec`'s `timeout` is MILLISECONDS** (default `30_000`) while the Config Bus key is
  documented in seconds. apcore-mcp's TypeScript backend passes the seconds value straight
  through, making a documented `timeout: 30` a **30 ms** fetch timeout. The conversion happens
  at the `loadSpec` call site here.
- **`timeout` configures one thing** — the spec fetch. It is never handed to
  `HTTPProxyRegistryWriter` as a per-call proxy timeout.
- **`headers` are threaded through** to `loadSpec`, and never logged: they are credentials,
  and they are deliberately not reused for proxied calls.
- **`buildOpenapiBackendFromConfig` resolves `Config.projectRoot`** and passes it, so a
  relative `spec` resolves against the project root rather than the process CWD on the one
  route most deployments use.

One deliberate divergence from the Python binding, matching Rust: an `apcore-a2a.openapi`
that is **not a mapping** is passed to `buildOpenapiBackendFromConfig` unchanged, so it is
reported as `apcore-a2a.openapi must be a mapping.` Python discards it, which turns the typo
`openapi: ./spec.json` — the mapping's one key written as the whole value — into "a backend
source is required" and sends the operator hunting for a missing flag instead of at the line
they wrote. An explicit `openapi: null` remains an ordinary absence in all three.

### The runtime floor (folded in from the unreleased 0.6.1)

The floor also moves to **apcore-js 0.30.0 / apcore-toolkit 0.11.1** — the same change,
since apcore-toolkit 0.11.0 is what shipped the OpenAPI Scanner this release is built on.

The apcore floor itself carries no behaviour change for this package. **0.29.0** closes the
ACL pattern array's shape at every entry point, adds `callerId` / `action` to
`ApprovalRequest`, adds a `CancelToken.raiseIfCancelled()` alias, and makes
`AsyncTaskManager.startReaper()` return a `Promise` — this package constructs no `ACLRule`,
no `ApprovalRequest`, and uses no `AsyncTaskManager`. **0.30.0** is confined to `Config` /
`BindingLoader`. `README.md`'s Requirements block also gained the `apcore-toolkit` line it
had been missing since 0.4.x, when `deepResolveRefs` made it a real dependency.

### Upgrade notes

An ACL rule whose `callers` or `targets` is `[]`, `["$or"]`, `["$not"]` or a multi-operand
`["$not", p1, p2]` is **refused at load** by apcore-js 0.29.0 rather than silently matching
nothing. Such a rule had been contributing nothing to the decision, so under
`defaultEffect: "allow"` it permitted the very call it named — and the public Agent Card
advertised the skill accordingly. See apcore's 0.29.0 changelog for the per-shape migration.

## [0.6.0] - 2026-09-01

Resolves `aiperceivable/apcore-a2a` issues #2, #3, #4 and #5, tracked here as #1.
One principle runs through all four: **apcore already draws these distinctions,
and a transport binding's job is to convey them, not to flatten them.**

Suite: 388 tests (was 339).
Runtime floor moves to apcore 0.28.0 / apcore-toolkit 0.10.2 (`apcore-js>=0.28.0` / `apcore-toolkit>=0.10.2`).

### Changed

- **A governance refusal is reported as itself** (spec srs FR-ERR-003, FR-ERR-009,
  FR-ERR-010, FR-ERR-012). `ACL_DENIED` moves from `-32001 "Task not found"` to
  `-32040 "Access denied"`; `APPROVAL_DENIED` and `APPROVAL_TIMEOUT` leave the
  `-32603` catch-all for `-32041 "Approval denied"` and `-32042 "Approval timed
  out"`. All three now reach `TASK_STATE_REJECTED` instead of
  `TASK_STATE_FAILED`, which matters most on `message/send`, where the response
  is a JSON-RPC `result` and the error code never reaches the caller at all —
  the state and its message are the entire payload.

  The old mapping told an agent a *different* failure had happened, one whose
  correct response was the opposite of the real one: `"Task not found"` sends a
  caller back to re-fetch or re-send the one thing that was fine, and
  `"Internal server error"` is the canonical *retryable* failure — for a call a
  human had explicitly refused. A2A §13.2's MUST NOT forbids revealing *the
  existence of a resource*, not the *class* of failure, so a fixed
  `"Access denied"` naming no caller, target or rule satisfies it while still
  telling an agent to stop.

  `-32001` now means only "unknown task id, or a task owned by another
  principal". `APPROVAL_PENDING` is untouched: still a resumable
  `TASK_STATE_INPUT_REQUIRED` carrying its message verbatim, which is how a
  caller learns the approval id it resumes with.

  **Breaking** for callers that matched `-32001` or the literal `"Task not
  found"` to detect an authorization failure.

- **The public Agent Card shows what an anonymous caller could actually invoke**
  (spec srs FR-AGC-003): every registered skill, minus those the ACL denies to
  the anonymous principal, minus those annotated `requires_approval`. The filter
  resolves one identity, so it runs once at card-build time — never per request
  on the auth-exempt `/.well-known/` route.

- **The extended Agent Card carries what the authenticated caller may invoke**
  (spec srs FR-AGC-004), including `requires_approval` skills, resolved against
  that caller's own identity.

- **`capabilities.extendedAgentCard` is no longer derived from `auth != null`
  alone** (spec srs FR-AGC-002, FR-AGC-006): this binding advertises the
  capability only because it now serves it.

- **Card visibility reads apcore's two governance axes apart** (spec srs
  FR-AGC-003 "The two axes" and criterion 11; FR-AGC-004 criteria 2 and 10).
  apcore 0.28.0 (`PROTOCOL_SPEC` §6.1.6) gave an ACL rule an `approval: required`
  field orthogonal to `effect`, so one check now resolves two independent results
  — may this caller reach this target, and must this call be put to a human — and
  made the legacy boolean `ACL.check` **fail closed** on the second. This binding
  filtered its cards on that boolean. Left alone, a skill the ACL *allows* the
  caller but gates behind a human would have silently vanished from the
  **extended** card too: a refusal the ACL never issued, and the caller left
  unable to learn that a capability it holds exists at all.

  Every card filter now reads `ACL.checkAccess` and filters on the
  authorization axis alone. The approval axis decides only *which surface*: it
  joins the module's `requires_approval` annotation as the second source the
  public card subtracts, composed by union exactly as apcore §6.9 composes them.
  Since 0.28.0 the annotation describes the *module*, not the call (apcore#110),
  so reading it alone would leave on the public card a skill an anonymous caller
  cannot in fact just call.

  The bug this closes was one line: `card-visibility.allowedSkillIds` called
  `acl.check(...)`. `ACL.checkAccess` returns an `AccessDecision`, and the filter
  now reads `decision.access` for visibility and `decision.approvalRequired` only
  to decide which surface. Public API gains `skillAccess()`; `allowedSkillIds()`
  stays and now means the authorization axis alone.

- **apcore's `system.*` management namespace never reaches the public Agent Card**
  (spec srs FR-AGC-003 criteria 12 and 13, FR-AGC-004 criterion 11;
  `aiperceivable/apcore-a2a#5`). Removed **unconditionally** — independent of ACL
  state, of the `requires_approval` annotation, and of how `sys_modules` is
  configured. Kept on the extended card, filtered per identity like any other
  skill.

  Every other subtraction the public card makes is governance-shaped, and with no
  ACL configured they all collapse: the ACL predicates are empty and the
  annotation covers only the three `system.control.*` write modules — leaving the
  six read modules, which enumerate the deployment's module inventory, health and
  usage, published to any anonymous caller on the auth-exempt `/.well-known/`
  route. `ACL.discover()` yields nothing for a missing root by design, so "no ACL
  at all" is the default rather than an edge case, and the rule that has to hold
  there cannot be shaped like a governance verdict.

- **Warns when an unprotected control surface is served** (spec srs FR-AGC-007).
  Server construction reads apcore's `Executor.governanceState()` and warns when
  `unprotected_control_surface` is true. It never refuses to start and never
  alters a card. Withholding `system.*` from the public card removes the surface
  from *discovery*, not from *dispatch*: apcore's approval gate warns once and
  continues with no `ApprovalHandler`, so the write modules stay callable, and the
  card rule must not be mistaken for a fix to that.

### Added

- **apcore's behavioral annotations reach the wire** (spec srs FR-SKL-004):
  `readonly`, `destructive`, `idempotent` and `requires_approval` are emitted as
  namespaced entries in the standard `tags` field — `apcore:readonly`,
  `apcore:destructive`, `apcore:idempotent`, `apcore:requires-approval` — in
  that fixed order, appended after the module's own tags and de-duplicated
  against them. Only `true` flags are emitted.

  A2A 1.0 `AgentSkill` has no `extensions` and no `metadata` member, so `tags`
  is the only carrier that exists. Without them the card carried enough to
  *construct* a call and not enough to judge whether making it is safe — and
  retry semantics were unusable, since `retryable` is a property of the error
  while whether a retry is safe is a property of the operation.

- **Governance refusal errors on the client**, so a refusal is not reported as
  a transient server failure.

- `AccessDeniedError`, `ApprovalDeniedError`, `ApprovalTimeoutError` and their
  base `GovernanceRefusedError`, exported from the package root.

- **`serve({ discloseRefusalReason: false })`** (spec srs FR-ERR-011): forwards
  apcore's own sanitized reason for the three governance codes instead of the
  fixed per-class string. The code never changes with the flag; only the message
  does.

- `src/adapters/card-visibility.ts` — `buildPublicCard` / `buildExtendedCard` /
  `allowedSkillIds`, the shared filter behind both card surfaces.

- **`GET /agent/authenticatedExtendedCard`, and `GetExtendedAgentCard` wired
  through the SDK's `extendedAgentCardProvider`.** This binding advertised
  `capabilities.extendedAgentCard` and served neither, so a client that read the
  flag and called the method — which A2A §3.2.x entitles it to do — got a
  method error.

### Fixed

- **`sys_modules` registered nothing** (`aiperceivable/apcore-a2a#5`). apcore reads
  `sys_modules.enabled`, a **top-level** config section; the flag was a silent
  no-op in every deployment since it was introduced.

  This binding built the registration `Config` as
  `{apcore: {sys_modules: {enabled: true}}}` while apcore reads
  `config.get('sys_modules.enabled')` in legacy mode, so `registerSysModules`
  returned at its first line and the `catch {}` around it had nothing to catch.
  Operator settings found under either spelling are now carried through,
  top-level winning.

  Fixed together with the namespace rule above, deliberately in that order:
  repairing the config path on its own is precisely what would have opened the
  hole that rule closes.

- `VERSION` in `src/index.ts` had drifted to `"0.4.1"` while `package.json` read
  `0.5.0`; both now read `0.6.0`.

## [0.5.0] - 2026-08-17

Minor release. Task-addressed methods are now scoped to the authenticated
principal, and failed tasks no longer collapse every error to a fixed string —
both from `aiperceivable/apexe` issues #33 and #34. Also accepts the A2A 0.3
wire the Explorer and client actually speak, and raises the apcore-js floor to
0.27.0. No breaking API change: the storage layer re-exports `@a2a-js/sdk`'s own
owner-scoped `TaskStore`. 328 tests pass.

### Fixed

- **Failed tasks no longer collapse every error to `"Internal server error"`.**
  `ApCoreAgentExecutor.execute` sent every code except `MODULE_TIMEOUT`,
  `EXECUTION_CANCELLED` and `APPROVAL_PENDING` to a fixed
  `"Internal server error"`, so an A2A caller could not tell a rejected argument
  from a crashed binary from a policy denial. Every apcore input guard —
  conflicting flags, option injection, control characters, schema validation —
  arrived as that one string, and `aiGuidance`, which exists to tell an agent
  what to do next, was computed and dropped.

  The failed-task text now goes through `ErrorMapper`, this package's single
  redaction policy, so the task-status surface classifies like the JSON-RPC
  surface. Internal and unrecognized errors keep the fixed string (srs
  FR-ERR-004 / FR-ERR-008; the shared `error_mapping.json` and
  `streaming_events.json` fixtures still pass unchanged) and ACL denials stay
  masked as `"Task not found"` (FR-ERR-003), but caller-fixable failures —
  schema validation, invalid input, unknown module — carry their sanitized
  detail plus `aiGuidance` when apcore supplied one. An agent that reads a
  guard refusal can now correct itself. Ported from the same fix in
  apcore-a2a-rust; `aiperceivable/apexe#33`.

  `aiGuidance` is gated on exactly those three classes, not on
  `error.userFixable`. Six apcore codes carry `userFixable === true` while
  mapping to the fixed string (`VERSION_CONSTRAINT_INVALID`,
  `BINDING_SCHEMA_INFERENCE_FAILED`, `BINDING_SCHEMA_MODE_CONFLICT`,
  `BINDING_STRICT_SCHEMA_INCOMPATIBLE`, `DEPENDENCY_NOT_FOUND`,
  `DEPENDENCY_VERSION_MISMATCH`), and `userFixable` is settable per-error by
  the module author — so gating on it would let a fixed, deliberately-opaque
  string be extended with internal detail that `sanitizeMessage` does not strip
  (module ids, versions, env-var names, hostnames), and would let any module
  widen the `ACL_DENIED` mask. `carriesCallerDetail` is the gate, and the
  `errorMapper message policy matches toJsonRpcError` test locks it to
  `ErrorMapper`'s own branching across every apcore error code.
- **`SCHEMA_VALIDATION_ERROR` is no longer treated as caller-fixable in every
  direction.** apcore raises the one code for input *and* output validation
  (`validateSchema(schema, data, "Input" | "Output")`), so a module returning
  the wrong shape reached the caller as `-32602 Invalid params` with apcore's
  default guidance claiming `"Input validation failed"` and pointing at a
  `details.errors` field an A2A caller never receives — a server-side defect
  reported as the caller's fault. Output validation now maps to the fixed
  internal string. The direction label apcore puts at the front of the message
  is the only signal available, so that prefix is matched; anything
  unrecognized (including a module raising the code with its own wording) keeps
  the caller-facing detail. Config validation needs no arm here: apcore-js
  raises `ConfigError` / `CONFIG_INVALID` for it, which the catch-all already
  masks.

### Fixed

- **The Explorer and the bundled `A2AClient` can talk to this package's own
  server again.** Both speak A2A 0.3 — `message/send`, `message/stream`,
  `tasks/get`, `tasks/cancel`, `role: "user"`, and no `A2A-Version` header —
  and every one of those requests was refused. This is the defect
  apcore-a2a-rust `ca10690` flagged on this repo; `aiperceivable/apexe#35`.

  Two independent gates had to be opened, and each is load-bearing on its own:

  - `jsonRpcHandler` and `restHandler` are now mounted with
    `legacyCompat: { enabled: true }`, which routes the A2A 0.3 method names.
    Without it a2a-js dispatches only the 1.0 PascalCase names (`SendMessage`,
    `GetTask`, ...) and answers everything else `-32601`. The option does not
    exist before `@a2a-js/sdk` 1.0.1, which is why the floor moves.
  - The Agent Card now advertises a second `supportedInterfaces` entry — the
    same JSONRPC binding at `protocolVersion: "0.3"`. a2a-js runs
    `validateVersion(requestedVersion, card, "JSONRPC")` *before* dispatch on
    both paths, and per A2A spec section 3.6.2 a request with no `A2A-Version`
    header is a 0.3 request, so against a 1.0-only card every header-less
    request was refused `-32009` regardless of its method name.

  The 1.0 entry stays first and unchanged, so the shared `agent_card.json`
  conformance fixture still matches and top-level `url` stays absent.
  apcore-a2a-python needs no equivalent entry because a2a-python's
  `enable_v0_3_compat` does not consult the card; this is the a2a-js-specific
  price of the same acceptance, and it is what the spec's own normative method
  table (srs Appendix B, which lists only the `message/send` / `tasks/*`
  spellings) requires of a conforming server.

### Changed

- Required `@a2a-js/sdk` floor raised to `>=1.0.1` (from `>=1.0.0-alpha.0`),
  which is what carries the v0.3 compat module used above.

  **Known upstream regression in 1.0.1: every semantic A2A error on the express
  JSON-RPC path reports `-32603` instead of its spec code.** `toJsonRpcError`
  and the `A2AError` class are bundled separately into `dist/server/index.js`
  and `dist/server/express/index.js`, so an error thrown by
  `DefaultRequestHandler` (from `@a2a-js/sdk/server`) fails both `instanceof`
  guards in the express copy and falls through to `INTERNAL_ERROR` with no
  `data`. `TaskNotFoundError` therefore arrives as `-32603 "Task not found:
  <id>"` rather than `-32001`; `TaskNotCancelableError` (`-32002`) and the rest
  are affected the same way. 1.0.0-alpha.0 emitted the correct codes.

  Consequences: the messages and the masking behaviour are unaffected, so the
  task scoping above still cannot be probed. This adapter's own `ErrorMapper`
  codes (`-32601` / `-32602` / `-32001` for apcore errors) are produced inside
  this package and are unaffected. `TASK_NOT_FOUND_CODE` in
  `tests/security/task-scoping.test.ts` pins the current value so a fixed SDK
  shows up as a failing test rather than passing silently.

  **`A2AClient` recovers the type it lost.** Its `JSONRPC_ERRORS` table keys on
  the spec codes, so a miscoded `-32603` stopped raising `TaskNotFoundError` /
  `TaskNotCancelableError` — a caller's `catch (e) { if (e instanceof
  TaskNotFoundError) … }` silently went dead. It now falls back to matching the
  message, which the bug leaves intact, but only when the code is `-32603`, and
  only against anchored patterns: `"Unexpected failure: Task not found in
  cache"` stays a generic `A2AServerError`. Once upstream is fixed the code
  lookups take over and the fallback becomes unreachable.

  This is deliberately **not** mirrored on the server side. Rewriting the wire
  code would mean intercepting responses and prefix-matching six message shapes
  while distinguishing them from this package's own correctly-coded errors —
  fragile, and it would hide the upstream bug rather than work around it. A
  third-party client still receives `-32603`; only this one recovers.

- **`docs/sdk-differences.md` rewritten against the shipped SDKs.** The file
  still described the 0.3-era pair: `/.well-known/agent.json` as *the* card path,
  a `TaskStore` whose `context` was optional, `TaskState.completed` /
  `"input-required"` string states, and `Part(root=TextPart(...))` /
  `{ kind: "text" }` tagged unions — none of which exist in 1.0. Every entry is
  now read off the shipped type definitions, including the two signatures easiest
  to get wrong when porting (`DefaultRequestHandler` takes the same three objects
  in a different order per language; TypeScript's `TaskStore` has no `delete`).

- **Task listing is `ListTasks`, not `tasks/list`.** The bundled client sent
  `tasks/list`, a name belonging to no A2A version — 1.0 calls it `ListTasks`
  and 0.3 had no listing method — so `list_tasks()` had always returned
  `-32601` against this server and against the Python one, and worked only
  against this project's Rust server, which implemented the invented name. The
  client now sends `ListTasks` with the `A2A-Version: 1.0` header both upstream
  SDKs require for 1.0 method names (a request without it is read as v0.3, spec
  3.6.2). No server-side change: this server was always correct.

  The parameter names were wrong too, which only an end-to-end call could
  surface: `ListTasksRequest` declares `pageSize` / `pageToken` / `contextId` /
  `status` / `historyLength`, and has no `limit` field at all — so even with the
  method name fixed, both SDK-backed servers answered `-32602 Invalid params`.
  The Rust server had never caught it because it ignores list parameters
  entirely. `list_tasks(limit=…)` keeps `limit` as the friendly parameter name
  and sends `pageSize` on the wire.

  The client test that covered this checked only the `limit` parameter, never
  the method name or the header; it now asserts both.

- **Two intermittent test failures traced to the test harness, not the server.**
  `tests/explorer/handler.test.ts` had a known `expected 404 to be 200` flake,
  and `tests/security/task-scoping.test.ts` had an unreported one that looked
  far worse: the cross-principal assertion in *scopes set to the owner* failed
  roughly 4% of runs, reading as if an attacker had been allowed to redirect
  another principal's webhook.

  Both were the same thing, and neither reached the server. `request(app)`
  starts and tears down a throwaway HTTP server per call; at these rates about
  1 request in 120 missed the app's middleware chain and came back
  `404 Cannot POST /`, which parses to an empty body — so `error?.code` read as
  `undefined` and the "attacker was refused" assertion failed. Instrumenting the
  auth middleware showed 119 probe hits for 120 requests: the failing request
  never entered the chain. Rebuilding the app 120 times gave ~1 failure;
  reusing one app across 600 requests gave none, with an identical route table
  every time.

  Both suites now open one server per app and reuse it, awaiting `listening`
  before the first request — `listen()` binds asynchronously, and handing
  supertest a socket that is not up yet reintroduces the same race. After the
  fix: task-scoping 70/70 runs green (was ~4% failing), explorer 70/70, and the
  full suite 12/12 (was failing roughly 1 run in 5).

- **`pnpm lint` works.** The script had always been `eslint src/ tests/`, but the
  repo carried no `eslint.config.*` and no eslint packages, so it failed on
  every invocation since ESLint 9 made flat config mandatory. Added
  `eslint.config.mjs` mirroring `apcore-cli-typescript`'s, and the three missing
  devDependencies. Result: 0 errors, 76 warnings (`no-explicit-any` and
  `no-non-null-assertion`, both `warn` as elsewhere in the ecosystem, nearly all
  in test files). The one warning in `src/` is gone — `lines.pop()!` is now
  `lines.pop() ?? ""`.

- **`streamMessage` stops on a terminal task state instead of a `final` flag,
  and yields the event rather than the JSON-RPC envelope.** `final` is an A2A 0.3
  construct that 1.0 removed, so the old check could never fire against a 1.0
  server — the stream only ended when the connection closed. It also yielded
  each frame whole (`{jsonrpc, id, result}`) while the docstring promised the
  event, so callers had to reach into `result` themselves. Both now match the
  Rust client, which already did this: the envelope is unwrapped, and a
  `TASK_STATE_COMPLETED` / `FAILED` / `CANCELED` / `REJECTED` status ends the
  stream after being yielded. Keepalive comment lines are skipped explicitly.

  The tests that covered this had pinned the 0.3 shapes (`{"kind":"status",
  "final":true}`) and passed regardless, so they were rewritten against 1.0
  frames — including one that asserts a stray `final` does *not* end a stream.

- **A JSON-RPC error frame on an SSE stream now raises instead of being yielded
  as an event.** Upstream reports a mid-stream failure as its own frame, tagged
  `event: error` with a JSON-RPC error response in `data:`. Envelope unwrapping
  only looks for `result`, so such a frame fell through and was handed to the
  caller as though it were an event — a caller reading `statusUpdate` saw
  nothing and the failure vanished, while the non-streaming path raised for a
  byte-identical payload. Both paths now share the same error mapping, so a
  `-32001` frame produces `TaskNotFoundError` wherever it arrives. Events
  received before the error frame are still delivered.

  The `try` around frame handling was also narrowed to cover parsing alone: it
  had been wide enough to swallow the new error, which would have restored the
  exact behaviour being fixed.

### Security

- **All six task-addressed methods are scoped to the authenticated principal** —
  `GetTask` / `ListTasks` / `CancelTask` and
  `Create|Get|List|DeleteTaskPushNotificationConfig`. `ListTasks` previously
  returned every caller's tasks including their output; a task could be read or
  cancelled by id from any caller; and a principal holding another's task id
  could redirect that task's terminal `statusUpdate` to a webhook of its
  choosing, or silently suppress the owner's notifications by deleting their
  config. Only the unguessability of a UUIDv4 task id stood in the way. Ported
  from the same fix in apcore-a2a-rust; `aiperceivable/apexe#34`.

  a2a-js already had the machinery: `InMemoryTaskStore` and
  `InMemoryPushNotificationStore` bucket by `ownerResolver(context)` — default
  `resolveUserScope`, i.e. `context.user?.userName` — and
  `DefaultRequestHandler` loads the task from that context-scoped store before
  every task-addressed method, throwing `TaskNotFoundError` when it is not
  visible. It was inert because the JSON-RPC and REST handlers were mounted with
  `UserBuilder.noAuthentication`, so every request carried an
  `UnauthenticatedUser`. Both are now mounted with `identityUserBuilder`, which
  resolves the principal from the `Identity` that `createAuthMiddleware` puts in
  its `AsyncLocalStorage`.

  Cross-principal access is masked as `-32001 Task not found` — the same code
  and the same message shape as an unknown id, both a pure function of the id
  the caller itself supplied, so task ids cannot be probed (srs FR-ERR-003).

  Callers with no `Identity` share a single owner bucket, as a2a-js's
  `UnauthenticatedUser` does — that covers both "no authenticator configured"
  and "an authenticator configured with `requireAuth: false` that did not
  authenticate this request". Single-tenant deployments are unaffected;
  configuring auth is what turns scoping on, and a permissive-mode deployment
  gets scoping only between authenticated callers.

  **Behaviour change for a custom `taskStore`.** Unlike the Rust binding, which
  holds ownership in a process-local map beside the store and fails *closed*,
  ownership here lives inside the store itself. Two consequences follow, and
  they point in opposite directions:

  - a store that persists the owner alongside the task keeps scoping across a
    restart — the caveat the Rust binding had to disclose does not apply, and no
    ownership map is retained beside the store, so nothing unbounded is
    introduced either.
  - **A consumer-supplied `TaskStore` that ignores its `ServerCallContext`
    argument disables scoping entirely** and fails *open*: every caller sees
    every caller's tasks, exactly as before. Upstream states the requirement as
    a SHOULD on the `TaskStore` contract ("implementations SHOULD use ... the
    authenticated caller's identity to scope data access"), so it cannot be
    enforced from here. Deployments passing `taskStore` must confirm their store
    scopes by `ownerResolver`.

  Not covered: `SendMessage` / `SendStreamingMessage` are not task-addressed and
  are unchanged; `SubscribeToTask` reaches the same context-scoped handler and
  inherits the scoping, but has no test here.

### Added

- `isServerSideSchemaError`, `carriesCallerDetail` and `sanitizeMessage` are now
  module-level exports of `adapters/errors.ts`, so the task-status surface
  applies exactly the same redaction and the same widening policy as the
  JSON-RPC surface. `ErrorMapper`'s own behaviour is unchanged apart from the
  output-validation arm above.

### Changed

- Required runtime bumped to `apcore-js >= 0.27.0` (from `>=0.26.0`). All six
  0.27.0 breaking changes were checked against this adapter; none of them
  reaches it, and all 306 pre-existing tests pass unmodified against 0.27.0.

  - **`PIPELINE_CONFIG_INVALID` renamed to `PIPELINE_CONFIGURATION_ERROR`** —
    this is the apcore-js half of the three-way split (apcore-rust renamed
    `CONFIGURATION_ERROR`; apcore-python already emitted the new code). The
    `ConfigurationError` class name is unchanged. `ErrorMapper` never
    referenced either code — a config error reaches it through
    `CONFIG_NAMESPACE_DUPLICATE` / `CONFIG_MOUNT_ERROR` / `CONFIG_BIND_ERROR`,
    which are untouched.
  - **`obs.redaction.sensitive_keys` replaces rather than merges the defaults**
    — an explicitly empty list now disables key-based redaction instead of
    falling back to the shipped 16 entries. The adapter configures no
    redaction and never constructs a `RedactionConfig`.
  - **Boolean coercion narrowed to exactly `"true"` / `"false"`,
    case-sensitive** — applies to `new SchemaValidator(true)`. The adapter
    never constructs a `SchemaValidator`; its own `SchemaConverter` translates
    JSON Schema for the Agent Card and does not coerce values. The JWT claim
    coercion in `auth/jwt.ts` is this adapter's own code and is unaffected.
  - **Unknown `pipeline.configure` keys are now a parse error** — the adapter
    declares no pipeline and calls no `buildStrategyFromConfig`.
  - **`_config.strict` rejects undeclared framework keys** — scoped to the
    `apcore` namespace's own framework sections. The adapter registers its
    settings under the separate, declared `apcore-a2a` namespace
    (`Config.registerNamespace` in `server/factory.ts`), which strict mode
    does not police.
  - **`afterStep` now fires after a recovered step body** — the adapter
    installs no step middleware. It calls `executor.use(...)` only with
    apcore's own `ObsLoggingMiddleware` / `ErrorHistoryMiddleware`, which are
    call middleware, not step middleware.

## [0.4.4] - 2026-07-14

Patch release. Bumps the required `apcore-js` floor to `0.26.0` to align the ecosystem on the 0.26.0 governance layer (additive, no breaking changes). No code or API changes.

## [0.4.3] - 2026-07-07
update package dependency version for apcore-toolkit (0.10.0) and increment project patch version

## [0.4.2] - 2026-06-25

Patch release. Bumps the required apcore-js runtime floor to 0.25.0 and apcore-toolkit to 0.9.1. No code or API changes; all 306 tests pass unmodified against the new runtime.

### Changed

- Required runtime bumped to `apcore-js >= 0.25.0` (from `>=0.24.0`) and `apcore-toolkit >= 0.9.1` (from `>=0.8.1`). The adapter's public surface is unaffected by the 0.24 → 0.25 delta.

  apcore 0.25.0 and apcore-toolkit 0.9.0–0.9.1 changes reviewed for adapter impact — none required a change:
  - **Config-driven ACL discovery (0.25.0, apcore #74)** — `ACL.discover(config)` is auto-wired in the `APCore` constructor, but is skipped when the caller supplies its own `Executor` (as the adapter does), so an explicitly configured ACL is never clobbered. No behavior change for the adapter.
  - **Registry module-id constants promoted to the public surface (0.25.0, apcore #30)** — export-surface-only addition; no behavior change.
  - **apcore-toolkit OpenAPI parser hardening (0.9.0–0.9.1)** — integer status-code keys and explicit-`null` fields no longer crash output/input schema extraction. No public API change; the adapter uses only `deepResolveRefs`, which is unaffected.


## [0.4.1] - 2026-06-15

Patch release. Bumps the required apcore-js runtime floor to 0.24.0 and apcore-toolkit to 0.8.1. No code or API changes; all 306 tests pass unmodified against the new runtime.

### Changed

- Required runtime bumped to `apcore-js >= 0.24.0` (from `>=0.22.0`) and `apcore-toolkit >= 0.8.1` (from `>=0.8.0`). The adapter's public surface is unaffected by the 0.22 → 0.24 delta.

  apcore 0.23.0–0.24.0 changes reviewed for adapter impact — none required a change:
  - **Per-instance `ToggleState` (0.24.0, apcore #71)** — the `Executor` constructor and `registerSysModules()` gained an optional `toggleState` option. The adapter's existing call sites use the back-compat form and fall back to the process-global toggle state — behaviorally identical for a single-registry server.
  - **`CircuitBreakerMiddleware` constructor rewrite (0.23.0, breaking)** — not used by the adapter.
  - **AI error-recovery metadata auto-populated on `ModuleError` (0.23.0)** — `userFixable` / `aiGuidance` now flow through the serialized error automatically; the adapter never backfilled them, so no change is needed.
  - **`A2ASubscriber` 4xx no-retry (0.23.0)** — applies to apcore's own event-system subscriber, not this adapter.


## [0.4.0] - 2026-06-01

### Changed

- **A2A protocol upgraded 0.3 → 1.0 (BREAKING)** — migrated to `@a2a-js/sdk >= 1.0.0-alpha.0` (protobuf-derived wire format):
  - `Part` is a flattened `oneof` (`{text}` / `{data}` / `{raw}` / `{url}`, accessed via `part.content.$case`); `TaskState` / `Role` are enums serializing full names (`TASK_STATE_*` / `ROLE_*`).
  - Events published via `AgentEvent.task()` / `.statusUpdate()` / `.artifactUpdate()`; `AgentExecutionEvent` is the `oneof` `{task|statusUpdate|artifactUpdate|message}` — no `kind:"status-update"` literals, no `final` flag.
  - `AgentCard`: `url` → `supportedInterfaces`; `supportsAuthenticatedExtendedCard` → `capabilities.extendedAgentCard`; `capabilities.extensions` added, `stateTransitionHistory` dropped; `AgentSkill.securityRequirements` added; new `provider` / `securityRequirements` / `signatures`.
  - `InMemoryTaskStore.load/save` now require a `ServerCallContext`; Agent Card served at `/.well-known/agent-card.json` (+ `/.well-known/agent.json` 0.3 alias).
- **`apcore-js` dependency** bumped to `>=0.22.0`; **added `apcore-toolkit >=0.8.0`** (schema `$ref` resolution via `deepResolveRefs`).
- **New apcore 0.22 capabilities wired** — streaming via `executor.stream()`, cooperative cancellation via `CancelToken`, `global_deadline` (seeded from `executionTimeout` into `data[CTX_GLOBAL_DEADLINE]`), `ObsLoggingMiddleware`, and `register_sys_modules` (new `sysModules` option).
- **Env prefix** — `APCORE__A2A` (double underscore) → `APCORE_A2A` (single underscore).
- **`ErrorMapper.sanitizeMessage`** changed from public to private, aligning with Python SDK and spec.

### Added

- **Error Formatter Registry** (§8.8) — `ErrorMapper` registers with `ErrorFormatterRegistry.register("a2a", ...)` at module load, making the A2A error formatter discoverable by the ecosystem.
- **Config Bus namespace** (§9.13) — registers the `apcore-a2a` namespace with env prefix `APCORE_A2A` and defaults for `execution_timeout`, `cors_origins`, `explorer`, `metrics`, `push_notifications`.
- **New error codes** in `ErrorMapper` — `MODULE_DISABLED` (→ "Module is currently disabled"), `CONFIG_NAMESPACE_DUPLICATE`, `CONFIG_MOUNT_ERROR`, `CONFIG_BIND_ERROR` (→ "Configuration error").
- **`format()` method** on `ErrorMapper` — implements the `ErrorFormatter` interface, delegating to `toJsonRpcError()`.
- **`pushNotifications`** option added to `A2AServerCreateOptions` and wired into capabilities.
- **`agentCard`** getter on `A2AClient` — equivalent to Python's `agent_card` async property.
- **`VERSION` constant** exported from top-level `index.ts`.
- **Top-level re-exports** — `AgentCardBuilder`, `SkillMapper`, `SchemaConverter`, `ErrorMapper`, `PartConverter`, `A2AServerFactory`, `ApCoreAgentExecutor`, `createAuthMiddleware`, `authIdentityStore`, `getAuthIdentity` now exported from `"apcore-a2a"`.
- **`extendedAgentCard`** derived from authenticator presence (not from the presence of `securitySchemes`), matching the Python/Rust SDKs.
- **Cross-language conformance suite** (`tests/conformance/`) mirroring the shared fixtures, and an Apache-2.0 **`LICENSE`**.
- A2A 1.0 migration covered by the full suite (incl. conformance) — **306 tests passing**.

---

## [0.3.0] - 2026-03-27

### Added

- **Display overlay in `SkillMapper`** (§5.13) — `toSkill()` reads `metadata.display.a2a` for skill name, description, and tags when present.
  - Skill name: `metadata.display.a2a.alias` → `metadata.display.alias` → humanized `module_id`.
  - Description: `metadata.display.a2a.description` → `metadata.display.description` → `descriptor.description`.
  - Guidance: appended to description if present in `a2a.guidance` or `display.guidance`.
  - Tags: `metadata.display.tags` → `descriptor.tags`.
- `metadata` field added to `ModuleDescriptor` interface.

### Changed

- **`apcore-js` bumped from `^0.9.0` to `^0.14.0`**.
- **Well-known endpoint** aligned to `/.well-known/agent.json` (was `agent-card.json`), matching Python SDK and A2A spec.
- **CLI `--execution-timeout`** now accepts seconds (was milliseconds) for cross-language consistency with Python SDK.
- **Environment variables** renamed with `APCORE_` prefix: `JWT_SECRET` → `APCORE_JWT_SECRET`, `A2A_EXECUTION_TIMEOUT` → `APCORE_A2A_EXECUTION_TIMEOUT`.

### Tests

- 13 new `SkillMapper` display overlay tests including empty-string fallthrough parity with Python.

---

## [0.2.2] - 2026-03-22

### Changed
- Rebrand: aipartnerup → aiperceivable

## [0.2.1] - 2026-03-11

### Fixed

- **Graceful shutdown hang** — `server.close()` did not terminate keep-alive connections, causing the process to hang on SIGINT/SIGTERM. Now tracks open sockets and destroys them on shutdown.
- **MaxListenersExceededWarning on repeated Ctrl+C** — each signal added another `close` listener to the server. Added a `shuttingDown` guard to ignore duplicate signals.

### Changed

- `crypto.randomUUID` replaced with `uuidv4` from `uuid` package for broader runtime compatibility
- Updated pnpm dependencies

## [0.2.0] - 2026-03-08

### Added

- **Examples**: 5 runnable demo modules with unified launcher (`examples/run.ts`)
  - Class-based modules: `text_echo`, `math_calc`, `greeting` (TypeBox schemas, `extensions/` directory)
  - Programmatic modules: `convert_temperature`, `word_count` (zero-code-intrusion via `module()` factory in `binding_demo/`)
  - JWT authentication demo with pre-generated test token
- **Explorer enhancements**: Auth bar and cURL generation
  - Token input with status indicator and `sessionStorage` persistence
  - Auto-generated cURL commands for every `message/send` request (rendered in `finally` block)
  - Keyboard shortcut display (`Ctrl+Enter` / `Cmd+Enter`)

### Fixed

- **Explorer not mounted** — `factory.ts` imported `createExplorerRouter` but never wired it; explorer route now properly mounted when `explorer: true`
- **Runtime crash on module discovery** — `SkillMapper.humanizeModuleId()` called `.replace()` on `undefined` because `Registry.getDefinition()` does not include `module_id`. Made `ModuleDescriptor.module_id` optional, added `moduleId` fallback parameter to `toSkill()`
- **Empty skill ID** — `toSkill()` returned a skill with `id: ""` when no ID was available; now returns `null` (P2)
- **Duplicate `explorerPrefix` resolution** — was resolved twice in `factory.ts`; extracted to single `const` (P1)
- **cURL skipped on JSON parse error** — `renderCurl` was in try block after response parsing; moved to `finally` block so cURL always renders (P2)

### Changed

- `apcore-js` dependency bumped from `^0.8.0` to `^0.9.0`
- `@sinclair/typebox` added as devDependency for example schemas
- Test coverage expanded from 157 to 238 tests (81 new explorer tests, 3 new skill-mapper tests)

## [0.1.0] - 2026-03-06

### Added

- **Adapters**: Automatic conversion between apcore modules and A2A protocol types
  - `SkillMapper` — converts `ModuleDescriptor` to `AgentSkill` with humanized names
  - `SchemaConverter` — JSON Schema conversion with `$ref` inlining (max depth 32)
  - `PartConverter` — bidirectional conversion between A2A `Part[]` and apcore inputs/outputs
  - `ErrorMapper` — maps apcore error codes to JSON-RPC error codes (ACL_DENIED masked as "Task not found")
  - `AgentCardBuilder` — generates A2A Agent Card from registry with caching and invalidation
- **Server Core**: Express-based A2A server powered by `@a2a-js/sdk`
  - `ApCoreAgentExecutor` — implements `AgentExecutor` interface, bridges apcore execution to A2A events
  - `A2AServerFactory` — wires all components into an Express app with JSON-RPC and Agent Card endpoints
  - `/health` endpoint with task store probe, module count, and uptime
  - `/metrics` endpoint with active/completed/failed/canceled task counters
- **Authentication**: JWT/Bearer auth bridge to apcore Identity
  - `JWTAuthenticator` — decodes JWT tokens with configurable claim mapping
  - `createAuthMiddleware` — Express middleware with exempt paths/prefixes
  - `AsyncLocalStorage`-based identity propagation via `getAuthIdentity()`
- **Client**: HTTP client for remote A2A agents
  - `A2AClient` — JSON-RPC client with `sendMessage`, `getTask`, `cancelTask`, `listTasks`
  - `streamMessage` — SSE streaming via `AsyncGenerator`
  - `AgentCardFetcher` — cached Agent Card discovery at `/.well-known/agent-card.json`
  - Error hierarchy: `A2AConnectionError`, `A2ADiscoveryError`, `TaskNotFoundError`, `TaskNotCancelableError`, `A2AServerError`
- **Public API**: Top-level entry points
  - `serve()` — blocking server start with graceful shutdown (SIGTERM/SIGINT)
  - `asyncServe()` — returns Express app for embedding
  - `resolveRegistryAndExecutor()` — duck-type resolution of Registry or Executor
- **Explorer**: Browser-based A2A skill discovery UI at configurable prefix
- **CLI**: `apcore-a2a serve` command with full option support
  - `--extensions-dir`, `--host`, `--port`, `--auth-type`, `--auth-key`, `--explorer`, `--metrics`, etc.
  - `resolveAuthKey` — reads JWT secret from file path, literal, or `JWT_SECRET` env var
- **Storage**: Re-exports `InMemoryTaskStore` and `TaskStore` from `@a2a-js/sdk`

### Dependencies

- `@a2a-js/sdk` ^0.3.10
- `apcore-js` ^0.8.0
- `express` ^5.1.0
- `jsonwebtoken` ^9.0.3

[0.2.1]: https://github.com/aiperceivable/apcore-a2a-typescript/releases/tag/v0.2.1
[0.2.0]: https://github.com/aiperceivable/apcore-a2a-typescript/releases/tag/v0.2.0
[0.1.0]: https://github.com/aiperceivable/apcore-a2a-typescript/releases/tag/v0.1.0
