# apcore-a2a-typescript — Implementation Plan

## Overview

Port of `apcore-a2a-python` to TypeScript. Automatically converts any apcore Module Registry into a fully functional A2A (Agent-to-Agent) protocol server with zero manual effort.

## Key Technology Mapping

| Python | TypeScript |
|--------|-----------|
| `a2a-sdk` (Starlette) | `@a2a-js/sdk` (Express) |
| `httpx` | Native `fetch` |
| `PyJWT` | `jsonwebtoken` |
| `ContextVar` | `AsyncLocalStorage` |
| `apcore` | `apcore-js` |
| `uvicorn` | Node.js `http.createServer` |
| Duck typing | TypeScript interfaces |
| `pytest` / `pytest-asyncio` | `vitest` |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ PUBLIC API: serve() / asyncServe() → Express app     │
│ Exports: serve, asyncServe, A2AClient                │
└──────────┬───────────────────────────────────────────┘
           │
    ┌──────▼──────────────────────────────────┐
    │ A2AServerFactory                        │
    │ • Wires adapters, executor, middleware   │
    │ • Creates Express app via @a2a-js/sdk   │
    │ • Adds /health, /metrics, /explorer     │
    └──────┬──────────────────────────────────┘
           │
    ┌──────▼──────────────────────┐
    │ ApCoreAgentExecutor         │
    │ implements AgentExecutor    │
    │ • Routes A2A → apcore call  │
    │ • Task state machine        │
    └──────┬──────────────────────┘
           │
    ┌──────▼───────────────┐    ┌───────────────────┐
    │ Adapters (F-01)      │    │ Auth (F-06)       │
    │ • SkillMapper        │    │ • JWTAuthenticator│
    │ • AgentCardBuilder   │    │ • AuthMiddleware  │
    │ • SchemaConverter    │    │ • AsyncLocalStore │
    │ • PartConverter      │    └───────────────────┘
    │ • ErrorMapper        │
    └──────────────────────┘
```

## Feature Implementation Order

Dependency-driven order (foundation → core → integration → tooling):

1. **F-01 Adapters** — Pure logic, no dependencies (foundation)
2. **F-02 Storage** — Re-exports from @a2a-js/sdk
3. **F-06 Auth** — Uses apcore-js Identity, AsyncLocalStorage
4. **F-03 Server Core** — Depends on F-01, F-02, F-06
5. **F-07 Client** — Independent (zero server imports)
6. **F-08 Public API** — Depends on F-03
7. **F-10 Explorer** — Depends on F-03 (Express routes)
8. **F-11 Ops** — Built into F-03 (health/metrics handlers)
9. **F-09 CLI** — Depends on F-08 (entry point)

## Source File Structure

```
src/
├── index.ts                 # Public API exports
├── serve.ts                 # serve() and asyncServe()
├── cli.ts                   # CLI entry point
├── adapters/
│   ├── index.ts             # Barrel export
│   ├── skill-mapper.ts      # ModuleDescriptor → AgentSkill
│   ├── agent-card.ts        # Registry → AgentCard
│   ├── schema.ts            # Schema $ref inlining
│   ├── parts.ts             # A2A Parts ↔ apcore I/O
│   └── errors.ts            # Exception → JSON-RPC error
├── auth/
│   ├── index.ts             # Barrel export
│   ├── types.ts             # Authenticator interface
│   ├── jwt.ts               # JWTAuthenticator
│   ├── middleware.ts         # Express auth middleware
│   └── storage.ts           # AsyncLocalStorage for identity
├── server/
│   ├── index.ts             # Barrel export
│   ├── executor.ts          # ApCoreAgentExecutor
│   └── factory.ts           # A2AServerFactory
├── client/
│   ├── index.ts             # Barrel export
│   ├── exceptions.ts        # Typed error classes
│   ├── card-fetcher.ts      # TTL-cached Agent Card
│   └── client.ts            # A2AClient
├── storage/
│   └── index.ts             # Re-exports from @a2a-js/sdk
└── explorer/
    ├── index.ts             # Barrel export
    ├── handler.ts           # Express route handler
    └── html.ts              # Embedded HTML UI
```

## Quality Gates

- **Coverage**: ≥90% line coverage (vitest --coverage)
- **Type safety**: strict mode, no `any` escape hatches in public API
- **Zero server imports in client**: `src/client/` must never import from `src/server/`
- **ESM-only**: `"type": "module"` in package.json
- **Node.js ≥18**: Use native fetch, crypto.randomUUID()
