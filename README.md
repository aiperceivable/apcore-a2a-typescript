<div align="center">
  <img src="https://raw.githubusercontent.com/aiperceivable/apcore-a2a/main/apcore-a2a-logo.svg" alt="apcore-a2a logo" width="200"/>
</div>

# apcore-a2a (TypeScript)

[![npm](https://img.shields.io/npm/v/apcore-a2a)](https://www.npmjs.com/package/apcore-a2a)
[![Node.js](https://img.shields.io/node/v/apcore-a2a)](https://www.npmjs.com/package/apcore-a2a)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Coverage](https://img.shields.io/badge/coverage-92%25-brightgreen)](https://github.com/aiperceivable/apcore-a2a-typescript)

## What is apcore-a2a?

**apcore-a2a** is the [A2A (Agent-to-Agent)](https://google.github.io/A2A/) protocol adapter for the [apcore](https://github.com/aiperceivable/apcore-typescript) ecosystem.

It solves a common problem: **you've built AI capabilities with apcore modules, but you need them to talk to other AI agents over a standard protocol.** apcore-a2a bridges that gap — it reads your existing module metadata (schemas, descriptions, examples) and automatically exposes them as a standards-compliant A2A server. No hand-written Agent Cards, no JSON-RPC boilerplate, no manual task lifecycle management.

**In short:** `apcore modules` + `apcore-a2a` = a fully functional A2A agent, ready to be discovered and invoked by any A2A-compatible client.

Built on [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) and [Express 5](https://expressjs.com/).

> **Also available in:** [Python](https://github.com/aiperceivable/apcore-a2a-python) | [Rust](https://github.com/aiperceivable/apcore-a2a-rust)

## Features

- **One-call server** — launch a compliant A2A server with `serve(registry)`
- **Automatic Agent Card** — `/.well-known/agent.json` generated from module metadata
- **Skill mapping** — apcore modules become A2A Skills with names, descriptions, tags, and examples; `metadata.display.a2a` overrides surface-facing fields (§5.13)
- **Full task lifecycle** — submitted, working, completed, failed, canceled, input-required
- **SSE streaming** — `message/stream` with real-time status and artifact updates
- **JWT authentication** — tokens bridged to apcore's Identity context
- **A2A Explorer UI** — browser UI for discovering and testing skills, with auth bar and cURL generation
- **Built-in client** — `A2AClient` for calling remote A2A agents
- **CLI support** — `npx apcore-a2a serve` for zero-code startup
- **Pluggable storage** — swap in Redis or PostgreSQL via the `TaskStore` interface
- **Observability** — `/health`, `/metrics` endpoints
- **Dynamic registration** — add/remove modules at runtime without restart

## Requirements

- Node.js >= 18.0.0
- `apcore-js` >= 0.15.1

---

## For Users: Getting Started

### Installation

```bash
npm install apcore-a2a
```

### Expose your modules as an A2A Agent

If you already have apcore modules, three lines turn them into a discoverable agent:

```typescript
import { Registry } from "apcore-js";
import { serve } from "apcore-a2a";

const registry = new Registry({ extensionsDir: "./extensions" });

serve(registry); // Starts on http://0.0.0.0:8000
```

Your agent is now live at `http://localhost:8000/.well-known/agent.json`.

### CLI (zero-code)

No code needed — use the CLI to serve modules directly:

```bash
npx apcore-a2a serve --extensions-dir ./extensions
npx apcore-a2a serve --extensions-dir ./extensions --port 3000 --explorer --metrics
npx apcore-a2a serve --extensions-dir ./extensions --auth-type bearer --auth-key mysecret
```

### Call a remote A2A Agent

Use the built-in client to discover and invoke any A2A-compliant agent:

```typescript
import { A2AClient } from "apcore-a2a";

const client = new A2AClient("http://agent.example.com", {
  auth: "Bearer my-token",
  timeout: 30_000,
});

// Discover what the agent can do
const card = await client.discover();
console.log(`Agent: ${card.name}, Skills: ${card.skills.length}`);

// Send a message
const task = await client.sendMessage(
  { role: "user", parts: [{ kind: "text", text: "hello" }] },
  { contextId: "ctx-1" },
);
console.log(`Result: ${task.status.state}`);

// Or stream the response
for await (const event of client.streamMessage(message)) {
  console.log(event);
}

client.close();
```

### Add authentication

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

---

## For Developers: API Reference

### `serve()`

Blocking call — starts an HTTP server and serves until SIGINT/SIGTERM.

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

### `asyncServe()`

Returns the Express app without starting a server — use for embedding in larger applications or testing.

```typescript
import { asyncServe } from "apcore-a2a";

const app = await asyncServe(registryOrExecutor, options);
// app is an Express application — mount it or start your own server
```

### `TaskStore`

Default in-memory task store. Implement the `TaskStore` interface (`save`, `load`) for persistent backends.

```typescript
import { InMemoryTaskStore } from "apcore-a2a/storage";

const store = new InMemoryTaskStore();
serve(registry, { taskStore: store });
```

### Architecture

```
apcore Registry
       |
       v
+---------------------------------------------+
|  apcore-a2a                                 |
|  +----------+  +-----------+  +----------+  |
|  | Adapters |  |  Server   |  |   Auth   |  |
|  | SkillMap |  | Executor  |  |  JWT     |  |
|  | Schema   |  | Factory   |  |  Middle  |  |
|  | Parts    |  | Health    |  |  Storage |  |
|  | ErrorMap |  | Metrics   |  |          |  |
|  | AgentCard|  |           |  |          |  |
|  +----------+  +-----------+  +----------+  |
|  +----------+  +-----------+                |
|  |  Client  |  | Explorer  |                |
|  | A2AClient|  | HTML UI   |                |
|  | CardFetch|  |           |                |
|  +----------+  +-----------+                |
+---------------------------------------------+
       |
       v
  @a2a-js/sdk + Express 5
```

| A2A Concept    | apcore Mapping                            |
| -------------- | ----------------------------------------- |
| **Agent Card** | Derived from Registry configuration       |
| **Skill id**   | `module_id`                               |
| **Skill name** | `metadata.display.a2a.alias` or humanized `module_id` |
| **Skill desc** | `metadata.display.a2a.description` or `module.description` |
| **Skill tags** | `metadata.display.tags` or `module.tags`  |
| **Task**       | Managed execution of `Executor.callAsync()` |
| **Streaming**  | Wrapped `Executor.stream()` via SSE       |
| **Security**   | Bridged to apcore's `Identity` context    |

### Examples

The `examples/` directory contains 5 runnable demo modules covering both integration styles:

```bash
# Run all 5 modules with Explorer UI
npx tsx examples/run.ts

# With JWT auth
JWT_SECRET=my-secret npx tsx examples/run.ts
```

Open http://127.0.0.1:8000/explorer/ to discover and test skills interactively.

See [`examples/README.md`](examples/README.md) for details on class-based vs programmatic module patterns.

### Contributing

```bash
git clone https://github.com/aiperceivable/apcore-a2a-typescript.git
cd apcore-a2a-typescript
npm install
npm test
```

## Documentation

- [Product Requirements (PRD)](https://github.com/aiperceivable/apcore-a2a/blob/main/docs/apcore-a2a/prd.md)
- [Technical Design](https://github.com/aiperceivable/apcore-a2a/blob/main/docs/apcore-a2a/tech-design.md)
- [Software Requirements (SRS)](https://github.com/aiperceivable/apcore-a2a/blob/main/docs/apcore-a2a/srs.md)

## License

Apache 2.0 — see [LICENSE](LICENSE).
