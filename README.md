<div align="center">
  <img src="https://raw.githubusercontent.com/aipartnerup/apcore-a2a/main/apcore-a2a-logo.svg" alt="apcore-a2a logo" width="200"/>
</div>

# apcore-a2a

[![npm](https://img.shields.io/npm/v/apcore-a2a)](https://www.npmjs.com/package/apcore-a2a)
[![Node.js](https://img.shields.io/node/v/apcore-a2a)](https://www.npmjs.com/package/apcore-a2a)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Coverage](https://img.shields.io/badge/coverage-92%25-brightgreen)](https://github.com/aipartnerup/apcore-a2a-typescript)

**apcore-a2a** automatically converts any apcore Module Registry into a fully functional [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/) server and client — zero boilerplate required.

Built on [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) and [Express 5](https://expressjs.com/).

## Installation

```bash
npm install apcore-a2a
```

## Quick Start

```typescript
import { Registry } from "apcore-js";
import { serve } from "apcore-a2a";

const registry = new Registry({ extensionsDir: "./extensions" });

serve(registry); // Starts on http://0.0.0.0:8000
```

Agent Card is automatically served at `/.well-known/agent-card.json`. All registered modules appear as A2A Skills.

### CLI

```bash
npx apcore-a2a serve --extensions-dir ./extensions
npx apcore-a2a serve --extensions-dir ./extensions --port 3000 --explorer --metrics
npx apcore-a2a serve --extensions-dir ./extensions --auth-type bearer --auth-key mysecret
```

## Features

- **Automatic Agent Card generation** — modules mapped to Skills with names, descriptions, tags, and examples
- **JSON-RPC 2.0 transport** — `message/send` and `message/stream` endpoints via `@a2a-js/sdk`
- **Full A2A task lifecycle** — submitted, working, completed, failed, canceled, input-required
- **SSE streaming** — `message/stream` with real-time `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent`
- **JWT authentication** — `JWTAuthenticator` bridges tokens to apcore Identity context
- **A2A Explorer UI** — optional browser UI for discovering and testing skills (`--explorer`)
- **A2A client** — `A2AClient` for discovering and invoking remote A2A agents
- **Pluggable storage** — swap in Redis or PostgreSQL via the `TaskStore` interface
- **Observability** — `/health` and `/metrics` endpoints
- **Dynamic registration** — add/remove modules at runtime without restart

## API Reference

### `serve()`

```typescript
import { serve } from "apcore-a2a";

serve(registryOrExecutor, {
  host: "0.0.0.0",           // Bind host (default: "0.0.0.0")
  port: 8000,                // Bind port (default: 8000)
  name: "my-agent",          // Agent name (fallback: registry config)
  description: "...",        // Agent description
  version: "1.0.0",          // Agent version
  url: "https://...",        // Public URL (default: http://{host}:{port})
  auth: authenticator,       // Authenticator instance
  taskStore: store,          // TaskStore instance (default: InMemoryTaskStore)
  corsOrigins: ["http://localhost:3000"],
  explorer: true,            // Enable A2A Explorer UI
  explorerPrefix: "/explorer",
  executionTimeout: 300_000, // ms (default: 300000)
  metrics: true,             // Enable /metrics endpoint
  shutdownTimeout: 30,       // Graceful shutdown timeout in seconds
});
```

Blocking call — starts an HTTP server and serves until SIGINT/SIGTERM.

### `asyncServe()`

```typescript
import { asyncServe } from "apcore-a2a";

const app = await asyncServe(registryOrExecutor, options);
// app is an Express application — mount it or start your own server
```

Returns the Express app without starting a server — use for embedding in larger applications or testing.

### `A2AClient`

```typescript
import { A2AClient } from "apcore-a2a";

const client = new A2AClient("http://agent.example.com", {
  auth: "Bearer my-token",
  timeout: 30_000,
});

const card = await client.discover();

const task = await client.sendMessage(
  { role: "user", parts: [{ kind: "text", text: "hello" }] },
  { contextId: "ctx-1" },
);

for await (const event of client.streamMessage(message)) {
  console.log(event);
}

client.close();
```

### `JWTAuthenticator`

```typescript
import { JWTAuthenticator } from "apcore-a2a";

const auth = new JWTAuthenticator("your-secret-key", {
  algorithms: ["HS256"],
  issuer: "https://auth.example.com",
  audience: "my-agent",
  claimMapping: {
    idClaim: "sub",
    typeClaim: "type",
    rolesClaim: "roles",
    attrsClaims: ["org", "dept"],
  },
  requireClaims: ["sub"],
});

serve(registry, { auth });
```

### TaskStore

```typescript
import { InMemoryTaskStore } from "apcore-a2a/storage";

const store = new InMemoryTaskStore();
serve(registry, { taskStore: store });
```

Default in-memory task store. Implement the `TaskStore` interface (`save`, `load`) for persistent backends.

## Architecture

```
apcore Registry
       │
       ▼
┌─────────────────────────────────────────────┐
│  apcore-a2a                                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐ │
│  │ Adapters  │  │  Server   │  │   Auth   │ │
│  │ SkillMap  │  │ Executor  │  │  JWT     │ │
│  │ Schema    │  │ Factory   │  │  Middle  │ │
│  │ Parts     │  │ Health    │  │  Storage │ │
│  │ ErrorMap  │  │ Metrics   │  │          │ │
│  │ AgentCard │  │           │  │          │ │
│  └──────────┘  └───────────┘  └──────────┘ │
│  ┌──────────┐  ┌───────────┐               │
│  │  Client  │  │ Explorer  │               │
│  │ A2AClient│  │ HTML UI   │               │
│  │ CardFetch│  │           │               │
│  └──────────┘  └───────────┘               │
└─────────────────────────────────────────────┘
       │
       ▼
  @a2a-js/sdk + Express 5
```

## Requirements

- Node.js >= 18.0.0
- `apcore-js` >= 0.8.0

## License

Apache 2.0 — see [LICENSE](LICENSE).
