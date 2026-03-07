# F-08: Public API — Implementation Plan

## Overview
Top-level entry points: `serve()` (blocking) and `asyncServe()` (returns Express app).

## Files

### `src/serve.ts`
Port of `apcore_a2a/_serve.py`

**Function: `asyncServe(registryOrExecutor, opts?): Promise<Express>`**
1. Resolve registry and executor via duck-typing
2. Validate registry has ≥1 module
3. Resolve metadata with fallbacks (name, description, version)
4. Default taskStore to InMemoryTaskStore
5. Validate auth protocol (authenticate, securitySchemes methods)
6. Validate taskStore protocol (save, load methods — @a2a-js/sdk interface)
7. Build app via A2AServerFactory.create()
8. Return Express app

**Function: `serve(registryOrExecutor, opts?): void`**
1. Resolve URL default
2. Call asyncServe()
3. Start HTTP server with `http.createServer(app).listen(port, host)`
4. Handle SIGTERM/SIGINT for graceful shutdown

**Function: `resolveRegistryAndExecutor(obj): { registry, executor }`**
- Duck-type: has `callAsync` → Executor (get `.registry`)
- Duck-type: has `list` + `getDefinition` → Registry
- Throws TypeError if neither

**Options interfaces:**
```typescript
interface AsyncServeOptions {
  name?: string;
  description?: string;
  version?: string;
  url?: string;
  auth?: Authenticator;
  taskStore?: TaskStore;
  corsOrigins?: string[];
  pushNotifications?: boolean;
  explorer?: boolean;
  explorerPrefix?: string;
  executionTimeout?: number;
  metrics?: boolean;
}

interface ServeOptions extends AsyncServeOptions {
  host?: string;  // default "0.0.0.0"
  port?: number;  // default 8000
  logLevel?: string;
  shutdownTimeout?: number;
}
```

### `src/index.ts`
```typescript
export { serve, asyncServe } from "./serve.js";
export { A2AClient } from "./client/index.js";
export type { Authenticator, ClaimMapping } from "./auth/index.js";
export { JWTAuthenticator } from "./auth/index.js";
```

## TDD Tasks

### T-08.1: resolveRegistryAndExecutor
1. RED: test executor (has callAsync) resolves to {registry, executor}
2. GREEN: implement executor detection
3. RED: test registry (has list + getDefinition) resolves
4. GREEN: implement registry detection
5. RED: test neither throws TypeError
6. GREEN: add error handling

### T-08.2: asyncServe
1. RED: test returns Express app
2. GREEN: implement asyncServe
3. RED: test validates zero modules
4. GREEN: add module count check
5. RED: test validates auth protocol
6. GREEN: add auth validation
7. RED: test validates taskStore protocol
8. GREEN: add taskStore validation

### T-08.3: serve
1. RED: test starts HTTP server
2. GREEN: implement serve with http.createServer
