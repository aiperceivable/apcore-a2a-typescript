# F-09: CLI — Implementation Plan

## Overview
CLI entry point: `apcore-a2a serve --extensions-dir ./ext`

## Files

### `src/cli.ts`
Port of `apcore_a2a/__main__.py`

Uses `node:util` `parseArgs` (same as apcore-mcp-typescript).

**Function: `main(): void`**
- Parse args with `parseArgs`
- `serve` subcommand with options:
  - `--extensions-dir` (required)
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
1. Validate extensions dir exists
2. Load Registry from apcore-js
3. Discover modules, exit 1 if none
4. Build auth (if --auth-type bearer)
5. Warn on 0.0.0.0 without auth
6. Call serve()

**Function: `resolveAuthKey(authKey?): string | undefined`**
- File path → read contents
- Literal string → use as-is
- None → check JWT_SECRET env var

**Shebang:** `#!/usr/bin/env node`

## TDD Tasks

### T-09.1: CLI argument parsing
1. RED: test parseArgs extracts all options
2. GREEN: implement arg parsing
3. RED: test missing extensions-dir exits 1
4. GREEN: add validation
5. RED: test resolveAuthKey file/literal/env resolution
6. GREEN: implement resolveAuthKey
