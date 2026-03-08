# Examples

Runnable demos of **apcore-a2a** with the A2A Explorer UI.

```
examples/
├── README.md                  # This file
├── run.ts                     # Unified launcher (all 5 modules)
├── extensions/                # Class-based apcore modules (using apcore-js types)
│   ├── text_echo.ts
│   ├── math_calc.ts
│   └── greeting.ts
└── binding_demo/              # Zero-code-intrusion demo
    ├── myapp.ts               # Plain business logic (NO apcore imports)
    └── run.ts                 # Wraps myapp functions via module() factory
```

## Quick Start (all modules together)

Both class-based modules and programmatic wrappers coexist in the same Registry.

```bash
# From the project root
npx tsx examples/run.ts
```

Open http://127.0.0.1:8000/explorer/ — you should see all 5 skills.

## Run class-based modules only

```bash
npx apcore-a2a serve \
  --extensions-dir ./examples/extensions \
  --explorer
```

Uses the built-in CLI directly.

## Run programmatic modules only

```bash
npx tsx examples/binding_demo/run.ts
```

## All Modules

| Module | Type | Description |
|--------|------|-------------|
| `text_echo` | class-based | Echo text back, optionally uppercase |
| `math_calc` | class-based | Basic arithmetic (add, sub, mul, div) |
| `greeting` | class-based | Personalized greeting in 3 styles (friendly, formal, pirate) |
| `convert_temperature` | module() factory | Celsius / Fahrenheit / Kelvin conversion |
| `word_count` | module() factory | Count words, characters, and lines |

## Two Integration Approaches

| | Class-based | module() factory |
|---|---|---|
| Your code changes | Write apcore module with default export | **None** — wrap existing functions |
| apcore-js imports | `ModuleAnnotations`, `DEFAULT_ANNOTATIONS`, `Context` | `Registry`, `Executor`, `module` |
| Schema definition | TypeBox `Type.Object(...)` in module file | TypeBox in the launcher script |
| Launch | CLI `--extensions-dir` or `Registry.discover()` | `module({ ..., registry })` |
| Best for | New projects | Existing projects with functions to expose |

## JWT Authentication

Enable JWT authentication by setting the `JWT_SECRET` environment variable:

```bash
JWT_SECRET=my-secret npx tsx examples/run.ts
```

### Test Token

Pre-generated token (secret: `my-secret`, algorithm: HS256):

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vLXVzZXIiLCJ0eXBlIjoidXNlciIsInJvbGVzIjpbImFkbWluIl19.yOFQMlZnMZwXg6KoJX61sCm2VbCzmqtT8dFRNsOhaZM
```

Payload:

```json
{"sub": "demo-user", "type": "user", "roles": ["admin"]}
```

### Verify with cURL

```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vLXVzZXIiLCJ0eXBlIjoidXNlciIsInJvbGVzIjpbImFkbWluIl19.yOFQMlZnMZwXg6KoJX61sCm2VbCzmqtT8dFRNsOhaZM"

# Agent Card endpoint is exempt from auth
curl http://localhost:8000/.well-known/agent-card.json

# Health endpoint is exempt from auth
curl http://localhost:8000/health

# Without token -> 401
curl -X POST http://localhost:8000/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"Hello"}],"metadata":{"skillId":"greeting"}}}}'

# With token -> 200
curl -X POST http://localhost:8000/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"Hello"}],"metadata":{"skillId":"greeting"}}}}'
```

### Explorer UI with JWT

The Explorer UI at http://127.0.0.1:8000/explorer/ is exempt from JWT authentication, so it always loads. The Explorer uses `sessionStorage` to persist a Bearer token — set it in the browser console if needed:

```js
sessionStorage.setItem("auth_token", "YOUR_JWT_TOKEN_HERE");
```
