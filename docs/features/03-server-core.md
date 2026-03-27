# F-03: Server Core — Implementation Plan

## Overview
Wires all components into an Express app via `@a2a-js/sdk`. Includes executor, factory, health/metrics endpoints.

## Files

### `src/server/executor.ts`
Port of `apcore_a2a/server/executor.py`

**Class: `ApCoreAgentExecutor` implements `AgentExecutor`**

Uses `@a2a-js/sdk/server` `AgentExecutor` interface:
```typescript
interface AgentExecutor {
  execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>;
  cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>;
}
```

Constructor:
```typescript
constructor(opts: {
  executor: any;           // apcore Executor (duck-typed)
  partConverter: PartConverter;
  errorMapper: ErrorMapper;
  registry?: any;          // apcore Registry
  executionTimeout?: number; // default 300s
  onStateChange?: (oldState: string, newState: string) => void;
})
```

**execute() flow:**
1. Extract `skillId` from `context.userMessage.metadata`
2. Validate skill exists in registry
3. Parse Parts → apcore input via PartConverter
4. Get identity from AsyncLocalStorage
5. Build apcore Context (dynamic import)
6. Call `executor.callAsync(skillId, inputs, context?)` with timeout
7. On success → publish TaskArtifactUpdateEvent + TaskStatusUpdateEvent(completed)
8. On timeout → publish failed
9. On APPROVAL_PENDING → publish input_required
10. On other error → publish failed("Internal server error")

**cancelTask():**
- Publish TaskStatusUpdateEvent(canceled)

**Key differences from Python:**
- Use `@a2a-js/sdk` `ExecutionEventBus.publish()` instead of Python `EventQueue.enqueue_event()`
- Use `AbortSignal.timeout()` instead of `asyncio.wait_for()`
- Use `getAuthIdentity()` from auth/storage instead of ContextVar

### `src/server/factory.ts`
Port of `apcore_a2a/server/factory.py`

**Class: `A2AServerFactory`**

```typescript
create(registry, executor, opts): { app: Express; agentCard: AgentCard }
```

**create() steps:**
1. Build adapters (SkillMapper, SchemaConverter, AgentCardBuilder, ErrorMapper, PartConverter)
2. Build AgentCard
3. Build MetricsState (if metrics enabled)
4. Build ApCoreAgentExecutor
5. Build DefaultRequestHandler from @a2a-js/sdk
6. Build Express app using `@a2a-js/sdk/server/express` utilities:
   - `jsonRpcHandler()` — JSON-RPC 2.0 endpoint at POST /
   - `agentCardHandler()` — GET /.well-known/agent.json
7. Add custom routes:
   - GET /health — task store probe, module count, uptime, version
   - GET /metrics (optional) — task counters
   - Explorer mount (optional)
8. Add middleware:
   - Request counter (if metrics)
   - Auth middleware (if auth provided)
   - CORS middleware (if cors_origins)
9. Return { app, agentCard }

**MetricsState class (internal):**
```typescript
class MetricsState {
  activeTasks = 0;
  completedTasks = 0;
  failedTasks = 0;
  canceledTasks = 0;
  inputRequiredTasks = 0;
  totalRequests = 0;
  private startTime = performance.now();
  uptimeSeconds(): number;
  onStateTransition(oldState: string, newState: string): void;
}
```

**registerModule(moduleId, descriptor): void** — runtime dynamic registration

## TDD Tasks

### T-03.1: ApCoreAgentExecutor
1. RED: test execute with valid skill → completed event
2. GREEN: implement execute flow
3. RED: test missing skillId → failed
4. GREEN: add skillId validation
5. RED: test unknown skill → failed
6. GREEN: add registry validation
7. RED: test execution timeout → failed
8. GREEN: add timeout handling
9. RED: test APPROVAL_PENDING → input_required
10. GREEN: add approval handling
11. RED: test cancelTask → canceled event
12. GREEN: implement cancelTask

### T-03.2: A2AServerFactory
1. RED: test create builds Express app with health endpoint
2. GREEN: implement factory.create()
3. RED: test health returns healthy with module count
4. GREEN: implement health handler
5. RED: test metrics endpoint when enabled
6. GREEN: implement metrics handler
7. RED: test auth middleware wired when auth provided
8. GREEN: wire auth middleware
9. RED: test CORS middleware wired
10. GREEN: wire CORS
11. RED: test registerModule invalidates cache
12. GREEN: implement registerModule

### T-03.3: MetricsState
1. RED: test onStateTransition increments counters
2. GREEN: implement MetricsState
3. RED: test request counting middleware
4. GREEN: implement request counter
