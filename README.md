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
- **Automatic Agent Card** — `/.well-known/agent-card.json` (A2A 1.0 primary; `/.well-known/agent.json` 0.3 alias) generated from module metadata
- **Skill mapping** — apcore modules become A2A Skills with names, descriptions, tags, and examples; `metadata.display.a2a` overrides surface-facing fields (§5.13)
- **Full task lifecycle** — submitted, working, completed, failed, canceled, input-required
- **SSE streaming** — `message/stream` with real-time status and artifact updates
- **Push notifications** — optional webhook delivery of task state changes
- **JWT authentication** — tokens bridged to apcore's Identity context
- **A2A Explorer UI** — browser UI for discovering and testing skills, with auth bar and cURL generation
- **Built-in client** — `A2AClient` for calling remote A2A agents
- **OpenAPI backend** — point the adapter at an OpenAPI 3.0/3.1 document and every operation becomes an A2A Skill, proxied over HTTP, with no apcore project on the other end
- **CLI support** — `npx apcore-a2a serve` for zero-code startup
- **Pluggable storage** — swap in Redis or PostgreSQL via the `TaskStore` interface
- **Observability** — `/health`, `/metrics` endpoints
- **Dynamic registration** — add/remove modules at runtime without restart

## Requirements

- Node.js >= 18.0.0
- `apcore-js` >= 0.31.0
- `apcore-toolkit` >= 0.13.0

> **OpenAPI backend.** No extra install. The backend needs apcore-toolkit's
> `OpenAPIScanner`, `loadSpec` and `HTTPProxyRegistryWriter`, all of which ship in
> the `apcore-toolkit` dependency above and use the global `fetch` available on
> Node 18+ — so this package declares no `openapi` optional dependency. (The
> Python distribution declares an `apcore-a2a[openapi]` extra because there the
> same three pieces sit behind `apcore-toolkit[http-proxy]`.)

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

// Discover modules before serving (requires top-level await or an async function)
await registry.discover();

serve(registry); // Starts on http://0.0.0.0:8000
```

Your agent is now live at `http://localhost:8000/.well-known/agent-card.json` (the A2A 1.0 primary endpoint; `/.well-known/agent.json` is also served as the 0.3 alias).

### CLI (zero-code)

No code needed — use the CLI to serve modules directly:

```bash
npx apcore-a2a serve --extensions-dir ./extensions
npx apcore-a2a serve --extensions-dir ./extensions --port 3000 --explorer --metrics
npx apcore-a2a serve --extensions-dir ./extensions --auth-type bearer --auth-key mysecret
```

### Serve an OpenAPI document as A2A Skills

Point the adapter at an OpenAPI 3.0/3.1 document and every operation becomes a
skill, proxied over HTTP to the API that published it. No apcore project required
on the other end.

```bash
npx apcore-a2a serve \
  --from-openapi https://petstore3.swagger.io/api/v3/openapi.json \
  --openapi-prefix petstore \
  --openapi-header "X-Api-Key: $PETSTORE_SPEC_KEY" \
  --openapi-no-deprecated
```

```typescript
import { openapiBackend, serve } from "apcore-a2a";

const registry = await openapiBackend("https://api.example.com/openapi.json", {
  prefix: "petstore",       // prepended to every derived module ID
  baseUrl: "https://api.example.com", // defaults to servers[0].url
  include: "pets\\..*",     // scanner filters
  timeout: 30,              // SPEC-FETCH timeout, in SECONDS
  headers: { "X-Api-Key": process.env.PETSTORE_SPEC_KEY! }, // spec fetch only
  authHeaderFactory: () => ({ Authorization: `Bearer ${mintToken()}` }), // proxied calls
});

serve(registry);
```

Each skill's ID is the module ID apcore-toolkit (>= 0.13) derives, already in
apcore's ID alphabet: `operationId: listPets` under prefix `petstore` becomes
`petstore.list_pets`, and `GET /pets/{petId}` without an `operationId` becomes
`petstore.pets.pet_id.get`. An operation whose ID still has a segment beginning
with a digit (`/v1/2fa`) is skipped with a warning — name it with a
`deriveModuleId` or `transformModule` hook.

Or configure it entirely through the Config Bus:

```yaml
apcore-a2a:
  openapi:
    spec: "https://api.example.com/openapi.json"  # URL, or a path resolved against Config.projectRoot
    base_url: "https://api.example.com"
    prefix: petstore
    include: "pets.*"
    exclude: "*.internal.*"
    include_deprecated: false
    acknowledge_unapproved_writes: false
    timeout: 30.0            # spec fetch, seconds — never the per-call proxy timeout
    headers:
      X-Api-Key: "${PETSTORE_SPEC_KEY}"
```

Three things are worth knowing before pointing this at a production API:

- **Write operations reach the PUBLIC Agent Card.** apcore-toolkit infers
  annotations from the HTTP method and never infers `requiresApproval`, so a
  `POST /charges` is annotated exactly like a `POST /echo` and appears on
  `/.well-known/agent-card.json`, a route that is auth-exempt by design. The
  backend logs a warning naming that exposure; close it with an ACL rule carrying
  `approval: required` (which also withholds the skill from the public card), or
  record the decision with `acknowledge_unapproved_writes: true`.
- **`headers` authenticate the spec fetch only.** They are never forwarded to
  proxied calls: a document is often public while the API behind it is not.
  Per-request credentials belong in `authHeaderFactory`.
- **ACL targets move when the upstream renames an operation.** Set `prefix` and
  write the catch-all deny against the prefix (`targets: ["petstore.*"]`), not
  against operation names.

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
const message = { role: "user", parts: [{ kind: "text", text: "hello" }] };
const task = await client.sendMessage(message, { contextId: "ctx-1" });
console.log(`Result: ${task.status.state}`);

// Or stream the response
for await (const event of client.streamMessage(message, { contextId: "ctx-1" })) {
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
  executionTimeout: 300,     // seconds (default: 300)
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
import { InMemoryTaskStore } from "@a2a-js/sdk/server";

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
pnpm install
pnpm test
```

## Documentation

- [Product Requirements (PRD)](https://github.com/aiperceivable/apcore-a2a/blob/main/docs/apcore-a2a/prd.md)
- [Technical Design](https://github.com/aiperceivable/apcore-a2a/blob/main/docs/apcore-a2a/tech-design.md)
- [Software Requirements (SRS)](https://github.com/aiperceivable/apcore-a2a/blob/main/docs/apcore-a2a/srs.md)

## License

Apache 2.0 — see [LICENSE](LICENSE).
