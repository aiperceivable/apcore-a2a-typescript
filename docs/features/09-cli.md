# F-09: CLI — Implementation Plan

## Overview
CLI entry point: `apcore-a2a serve --extensions-dir ./ext`

## Files

### `src/cli.ts`
Port of `apcore_a2a/__main__.py`

Uses `node:util` `parseArgs` (same as apcore-mcp-typescript).

**Function: `main(): void`**
- Parse args with `parseCliArgs` (a `parseArgs` wrapper, split out so the flag
  table is reachable from a test without starting a server)
- `serve` subcommand with options:
  - `--extensions-dir` (one of this, `--from-openapi`, or an
    `apcore-a2a.openapi.spec` in the apcore config is required; since 0.7.0)
  - `--from-openapi` (OpenAPI 3.0/3.1 URL or path; feature F-12)
  - `--openapi-base-url`, `--openapi-prefix`, `--openapi-include`, `--openapi-exclude`
  - `--openapi-header` (repeatable `KEY:VALUE`, spec fetch only)
  - `--openapi-no-deprecated` (**no `default`** — see `mergeOpenapiSettings`)
  - `--host` (default "127.0.0.1")
  - `--port` (default 8000)
  - `--name`, `--description`, `--version-str`
  - `--url`
  - `--auth-type bearer`
  - `--auth-key`
  - `--auth-issuer`, `--auth-audience`
  - `--push-notifications`
  - `--explorer`
  - `--cors-origins` (comma-separated)
  - `--execution-timeout` (default 300)
  - `--log-level` (debug|info|warning|error)
  - `--version` (show version)

**Function: `runServe(args): void`**
1. Resolve the OpenAPI settings via `mergeOpenapiSettings`, then require at least
   one backend source (`--extensions-dir`, or settings naming a `spec`) — the
   usage check has to consult the Config Bus, or a config file that names a
   `spec` would be rejected for naming no flag
2. Validate the extensions dir exists, when given
3. Load Registry from apcore-js
4. When the settings name a `spec`, populate the same Registry via
   `buildOpenapiBackendFromConfig` (a `prefix` is mandatory alongside
   `--extensions-dir`, and may come from either route)
5. Exit 1 if the registry ends up empty
6. Build auth (if --auth-type bearer)
7. Warn on 0.0.0.0 without auth
8. Call serve()

**Function: `mergeOpenapiSettings(values): Promise<unknown>`**
- Reads the `apcore-a2a.openapi` Config Bus section through `getA2aSetting`, then
  overlays the CLI flags: `--from-openapi`→`spec`, `--openapi-base-url`→`base_url`,
  `--openapi-prefix`→`prefix`, `--openapi-include`→`include`,
  `--openapi-exclude`→`exclude`, `--openapi-header`→`headers`,
  `--openapi-no-deprecated`→`include_deprecated` (negated)
- **Per key, not per source.** A flag alongside a config-declared `spec` takes
  effect; a config key with no flag survives. Choosing the whole source by
  whoever named `spec` would make `--openapi-prefix` a silent no-op — the shape
  of the apcore-mcp defect filed upstream as apcore-mcp-rust#8
- **An absent flag never overrides.** Only a flag the operator actually passed is
  overlaid, which is why `--openapi-no-deprecated` carries no `default: false`:
  with one, not passing it would overwrite a config `include_deprecated: false`
  with `true`
- Returns `null` when neither route names a `spec` — the ordinary "no OpenAPI
  configured" outcome, not an error. A section that is **not a mapping** is
  returned unchanged so `buildOpenapiBackendFromConfig` reports it by name
  (the Rust binding's behaviour; the Python one discards it)
- The keys with no flag — `timeout`, `headers`, `acknowledge_unapproved_writes` —
  are reachable only through the config file

**Function: `parseOpenapiHeaders(raw): Record<string,string> | undefined`**
- `"Key: Value"` occurrences → a header map for the **spec fetch only**
- A malformed entry is a usage error whose message never echoes the value

**Function: `resolveAuthKey(authKey?): string | undefined`**
- File path → read contents
- Literal string → use as-is
- None → check JWT_SECRET env var

**Shebang:** `#!/usr/bin/env node`

### `src/config.ts`
Port of `apcore_a2a/_config.py`. Holds `registerA2aNamespace()` (the single
registration site for the `apcore-a2a` namespace — a second
`Config.registerNamespace` for the same name throws) and `getA2aSetting(key)`.

It exists apart from `server/factory.ts` because the CLI reads
`apcore-a2a.openapi` before it has a Registry to serve: importing the factory —
and express, and the A2A SDK — merely to register a namespace would put the whole
server on the startup path of `serve --help`.

## TDD Tasks

### T-09.1: CLI argument parsing
1. RED: test parseArgs extracts all options
2. GREEN: implement arg parsing
3. RED: test missing extensions-dir exits 1
4. GREEN: add validation
5. RED: test resolveAuthKey file/literal/env resolution
6. GREEN: implement resolveAuthKey
