# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/aipartnerup/apcore-a2a-typescript/releases/tag/v0.1.0
