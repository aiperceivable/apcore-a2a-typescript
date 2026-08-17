# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  task scoping above still cannot be probed; but `A2AClient` no longer raises
  `TaskNotFoundError` / `TaskNotCancelableError` for those responses, because
  its `JSONRPC_ERRORS` table keys on the spec codes. This adapter's own
  `ErrorMapper` codes (`-32601` / `-32602` / `-32001` for apcore errors) are
  produced inside this package and are unaffected. `TASK_NOT_FOUND_CODE` in
  `tests/security/task-scoping.test.ts` pins the current value so a fixed SDK
  shows up as a failing test rather than passing silently.

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
