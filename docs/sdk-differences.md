# Python vs TypeScript SDK Differences

Differences between `a2a-sdk` (Python) and `@a2a-js/sdk` (TypeScript) that affect
this port. Both are on **A2A 1.0** — protobuf-derived types, `oneof` wire shapes,
and a `ServerCallContext` threaded through storage.

> Verified against `a2a-sdk>=1.0.0` and `@a2a-js/sdk>=1.0.1`. Everything below was
> read off the shipped type definitions, not carried over from the 0.3 port.

## Agent Card Path

Both serve **`/.well-known/agent-card.json`** as the A2A 1.0 path, with
`/.well-known/agent.json` kept as a 0.3-era alias. The card itself has no
top-level `url`; interfaces live under `supportedInterfaces`.

## TaskStore Interface

| | Python | TypeScript |
|---|---|---|
| write | `save(task, context)` | `save(task, context)` |
| read | `get(task_id, context)` | `load(taskId, context)` |
| list | `list(params, context)` | `list(params, context)` |
| delete | `delete(task_id, context)` | **not in the interface** |

`context: ServerCallContext` is **required** on every method in both SDKs — it is
what scopes tasks to their owner (Python resolves the owner via an injectable
`OwnerResolver`; TypeScript buckets per context). A store that ignores it
disables task isolation; upstream states this as a SHOULD, so neither SDK can
enforce it.

The health probe therefore calls `load("__health_probe__", ctx)` in TypeScript
and `get(...)` in Python, and must pass an explicit context in both.

## AgentExecutor Interface

- Python: `execute(context, event_queue)`, `cancel(context, event_queue)`
- TypeScript: `execute(requestContext, eventBus)`, `cancelTask(taskId, eventBus)`

TypeScript's cancel receives only the task id, not a full context.

## Event Publishing

- Python: `await event_queue.enqueue_event(event)` (async)
- TypeScript: `eventBus.publish(event)` (sync). Completion is observed through
  the bus's `'finished'` event (`on`/`once`), not by calling a method on it.

Both require the executor to emit a `Task` event **before** any
`TaskStatusUpdateEvent` — an A2A 1.0 requirement that 0.3 did not have.

## RequestContext

| | Python | TypeScript |
|---|---|---|
| inbound message | `context.message` | `context.userMessage` |
| task id | `context.task_id` | `context.taskId` |
| context id | `context.context_id` | `context.contextId` |
| call context | `context.call_context` | `context.context` |

The call context is where the authenticated principal reaches storage, so it is
the field task scoping depends on.

## Server Integration

- Python: compose `create_jsonrpc_routes` / `create_rest_routes` /
  `create_agent_card_routes` into a Starlette app. `A2AStarletteApplication` is
  gone. Custom routes (health, explorer) must be mounted **before** the REST
  routes, which end in a `Mount /{tenant}` wildcard that would otherwise swallow
  them.
- TypeScript: compose Express middlewares — `jsonRpcHandler({ requestHandler })`
  on `POST /`, `agentCardHandler({ agentCardProvider })`, `restHandler({...})` —
  onto an app you build yourself with `express()`.

## DefaultRequestHandler Constructor

- Python: `(agent_executor, task_store, agent_card, queue_manager?,
  push_config_store?, extended_agent_card?)` — `agent_card` is a **required
  third positional** argument in 1.0.
- TypeScript: `(agentCard, taskStore, agentExecutor, eventBusManager?,
  pushNotificationStore?, pushNotificationSender?, extendedAgentCardProvider?)` —
  `agentCard` comes **first**.

The first three arguments are the same three objects in a different order; this
is the easiest signature to get wrong when porting.

## TaskState Values

Both use the protobuf enum with full names — `TASK_STATE_SUBMITTED`,
`TASK_STATE_WORKING`, `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`,
`TASK_STATE_CANCELED`, `TASK_STATE_INPUT_REQUIRED`. The 0.3 spellings
(`TaskState.completed`, `"input-required"`) are gone from both.

## Part Types

`Part` is a flattened protobuf `oneof` in both — no `kind`/`type` discriminator
on the wire.

- Python: construct `Part(text=...)` / `Part(data=...)`; inspect with
  `part.WhichOneof("content")`. A data part's payload goes through
  `ParseDict(dict, struct_pb2.Value())` and reads back via `MessageToDict`.
- TypeScript: construct `Part.fromJSON({ text })` / `Part.fromJSON({ data })`;
  inspect with `part.content.$case` (`"text" | "data" | "raw" | "url"`) and read
  `part.content.value`. There is no `.create()` — `MessageFns` exposes only
  `fromJSON` / `toJSON`.

## Push Notification Config Store

- Python: `InMemoryPushNotificationConfigStore` from
  `a2a.server.tasks.inmemory_push_notification_config_store`; delivery and retry
  are internal to the SDK.
- TypeScript: the SDK owns config storage and delivery the same way; this
  adapter does not inject a store on either side.

(The Rust SDK, having no upstream, defines its own pluggable `PushConfigStore` —
see the spec repo's `features/storage.md`.)

## Auth Middleware

- Python: ASGI middleware (raw `scope`/`receive`/`send`)
- TypeScript: Express middleware (`req`, `res`, `next`)

Both exempt the same paths in this adapter: `/.well-known/agent-card.json`,
`/.well-known/agent.json`, `/health`, `/metrics`, plus the explorer prefix when
the Explorer is enabled.

## Known Upstream Issue (TypeScript only)

`@a2a-js/sdk` 1.0.1 bundles `toJsonRpcError` and the `A2AError` class separately
into `dist/server/index.js` and `dist/server/express/index.js`. An error thrown
by `DefaultRequestHandler` fails both `instanceof` guards in the express copy, so
every semantic A2A error (`-32001` … `-32006`) arrives as `-32603` with its
message intact. `A2AClient` in this package falls back to matching the message;
the wire code stays wrong until upstream fixes the bundling.
