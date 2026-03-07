# F-02: Storage — Implementation Plan

## Overview
Re-exports TaskStore and InMemoryTaskStore from `@a2a-js/sdk`. Minimal code.

## Files

### `src/storage/index.ts`
```typescript
export { InMemoryTaskStore } from "@a2a-js/sdk/server";
export type { TaskStore } from "@a2a-js/sdk/server";
```

## TDD Tasks

### T-02.1: Storage re-exports
1. RED: test that InMemoryTaskStore can be imported from storage
2. GREEN: add re-exports
3. RED: test InMemoryTaskStore save/load round-trip
4. GREEN: verify SDK store works
