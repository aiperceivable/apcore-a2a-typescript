# Python vs TypeScript SDK Differences

Critical differences between `a2a-sdk` (Python) and `@a2a-js/sdk` (TypeScript) that affect the port.

## Agent Card Path
- Both: `/.well-known/agent.json`

## TaskStore Interface
- Python: `save(task)`, `get(task_id)`, `delete(task_id)`
- TypeScript: `save(task, context?)`, `load(task_id, context?)` (no delete)

Health probe uses `load("__health_probe__")` instead of `get("__health_probe__")`.

## AgentExecutor Interface
- Python: `execute(context, event_queue)`, `cancel(context, event_queue)`
- TypeScript: `execute(context, eventBus)`, `cancelTask(taskId, eventBus)`

## Event Publishing
- Python: `await event_queue.enqueue_event(event)` (async)
- TypeScript: `eventBus.publish(event)` (sync) + `eventBus.finished()` to signal completion

## RequestContext
- Python: `context.message`, `context.task_id`, `context.context_id`
- TypeScript: `context.userMessage`, `context.taskId`, `context.contextId`

## Express Integration
- Python: `A2AStarletteApplication.build(routes, middleware)` — builds full Starlette app
- TypeScript: Composable Express middlewares:
  - `jsonRpcHandler({ requestHandler, userBuilder })` — POST /
  - `agentCardHandler({ agentCardProvider })` — GET /.well-known/agent.json
  - Build Express app manually with `express()`

## DefaultRequestHandler Constructor
- Python: `(agent_executor, task_store, queue_manager, push_config_store?)`
- TypeScript: `(agentCard, taskStore, agentExecutor, eventBusManager?, pushNotificationStore?, pushNotificationSender?, extendedAgentCardProvider?)`

Note: TypeScript constructor requires `agentCard` as first param.

## TaskState Enum Values
- Python: `TaskState.completed`, `TaskState.failed`, `TaskState.canceled`, `TaskState.input_required`
- TypeScript: `"completed"`, `"failed"`, `"canceled"`, `"input-required"` (string literals with hyphen)

## Part Types
- Python: `Part(root=TextPart(text=...))` — discriminated union with `.root`
- TypeScript: `{ kind: "text", text: ... }` — tagged union with `.kind`

## Auth Middleware
- Python: ASGI middleware (raw scope/receive/send)
- TypeScript: Express middleware (req, res, next)

## Exempt Paths for Auth
- Both: `/.well-known/agent.json`, `/health`, `/metrics`
