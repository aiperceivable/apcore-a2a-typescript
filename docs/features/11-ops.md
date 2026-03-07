# F-11: Ops — Implementation Plan

## Overview
Health check and metrics endpoints. Built into F-03 (A2AServerFactory).

## Endpoints

### `GET /health`
Returns JSON:
```json
{
  "status": "healthy",
  "uptime_seconds": 123.45,
  "module_count": 5,
  "version": "0.1.0"
}
```
Probes task store: if store.get("__health_probe__") throws → status 503 "unhealthy".

### `GET /metrics` (optional, requires `metrics: true`)
Returns JSON:
```json
{
  "active_tasks": 0,
  "completed_tasks": 10,
  "failed_tasks": 2,
  "canceled_tasks": 1,
  "input_required_tasks": 0,
  "total_requests": 50,
  "uptime_seconds": 123.45
}
```

## Implementation
Both handlers are created in `src/server/factory.ts` and mounted as Express routes.
See F-03 plan for implementation details.

## TDD Tasks
Covered by T-03.2 (A2AServerFactory tests).
