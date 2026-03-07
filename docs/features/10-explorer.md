# F-10: Explorer — Implementation Plan

## Overview
Browser-based interactive UI for skill discovery and testing.

## Files

### `src/explorer/handler.ts`
Port of `apcore_a2a/explorer/__init__.py`

**Function: `createExplorerRouter(agentCard, opts?): express.Router`**

Creates Express router with:
- `GET /` — serves embedded HTML
- `GET /agent-card` — serves AgentCard as JSON

### `src/explorer/html.ts`
Embedded HTML string (same content as Python's `index.html`).
Copy from `apcore-a2a-python/src/apcore_a2a/explorer/index.html`.

### `src/explorer/index.ts`
```typescript
export { createExplorerRouter } from "./handler.js";
```

## TDD Tasks

### T-10.1: Explorer routes
1. RED: test GET / returns HTML
2. GREEN: implement serve_index
3. RED: test GET /agent-card returns JSON
4. GREEN: implement serve_agent_card
