# F-07: Client — Implementation Plan

## Overview
Async HTTP client for remote A2A agents. Zero server imports (standalone library).

## Files

### `src/client/exceptions.ts`
Port of `apcore_a2a/client/exceptions.py`

```typescript
export class A2AClientError extends Error {}
export class A2AConnectionError extends A2AClientError {}
export class A2ADiscoveryError extends A2AClientError {}
export class TaskNotFoundError extends A2AClientError {
  constructor(public taskId?: string);
}
export class TaskNotCancelableError extends A2AClientError {
  constructor(public state?: string);
}
export class A2AServerError extends A2AClientError {
  constructor(message: string, public code: number = -32603);
}
```

### `src/client/card-fetcher.ts`
Port of `apcore_a2a/client/card_fetcher.py`

**Class: `AgentCardFetcher`**
- Constructor: `(baseUrl: string, opts?: { ttl?: number; headers?: Record<string,string> })`
- `fetch(): Promise<Record<string, unknown>>` — GET `/.well-known/agent.json` with TTL caching
- Uses native `fetch()` (Node.js 18+)
- Throws `A2ADiscoveryError` on HTTP error or JSON parse failure

### `src/client/client.ts`
Port of `apcore_a2a/client/client.py`

**Class: `A2AClient`**
- Constructor: `(url: string, opts?: { auth?: string; timeout?: number; cardTtl?: number })`
- URL validation (http/https only)
- Methods:
  - `discover(): Promise<Record<string, unknown>>` — fetch Agent Card
  - `sendMessage(message, opts?): Promise<Record<string, unknown>>` — JSON-RPC message/send
  - `getTask(taskId): Promise<Record<string, unknown>>` — tasks/get
  - `cancelTask(taskId): Promise<Record<string, unknown>>` — tasks/cancel
  - `listTasks(opts?): Promise<Record<string, unknown>>` — tasks/list
  - `streamMessage(message, opts?): AsyncGenerator<Record<string, unknown>>` — SSE streaming
  - `close(): void` — cleanup (AbortController)
- Uses native `fetch()` with AbortSignal.timeout
- Implements `Symbol.asyncDispose` for `await using` pattern

**Key difference from Python:**
- No httpx dependency — use native fetch
- SSE parsing done manually (same as Python: parse `data: ` lines)
- `async dispose` instead of `__aexit__`

## TDD Tasks

### T-07.1: Exceptions
1. RED: test error hierarchy
2. GREEN: implement all exception classes

### T-07.2: AgentCardFetcher
1. RED: test fetch returns card JSON
2. GREEN: implement fetch with native fetch
3. RED: test TTL caching
4. GREEN: add TTL logic
5. RED: test HTTP error throws A2ADiscoveryError
6. GREEN: add error handling

### T-07.3: A2AClient
1. RED: test URL validation rejects non-HTTP
2. GREEN: implement validateUrl
3. RED: test sendMessage sends JSON-RPC
4. GREEN: implement jsonrpcCall + sendMessage
5. RED: test JSON-RPC error raises typed exception
6. GREEN: add error mapping
7. RED: test streamMessage yields SSE events
8. GREEN: implement SSE parsing
9. RED: test close/dispose cleanup
10. GREEN: implement close
