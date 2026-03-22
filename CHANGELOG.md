# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
