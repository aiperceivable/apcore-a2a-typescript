# F-06: Auth — Implementation Plan

## Overview
JWT/Bearer authentication bridge between HTTP headers and apcore Identity.

## Files

### `src/auth/types.ts`
Port of `apcore_a2a/auth/protocol.py`

**Interface: `Authenticator`**
```typescript
interface Authenticator {
  authenticate(headers: Record<string, string>): Identity | null;
  securitySchemes(): Record<string, unknown>;
}
```

### `src/auth/storage.ts`
Port of `apcore_a2a/auth/middleware.py` (ContextVar part)

Uses `AsyncLocalStorage` from `node:async_hooks` (same pattern as apcore-mcp-typescript).

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import type { Identity } from "apcore-js";

export const authIdentityStore = new AsyncLocalStorage<Identity | null>();
export function getAuthIdentity(): Identity | null {
  return authIdentityStore.getStore() ?? null;
}
```

### `src/auth/jwt.ts`
Port of `apcore_a2a/auth/jwt.py`

**Interface: `ClaimMapping`**
```typescript
interface ClaimMapping {
  idClaim?: string;      // default "sub"
  typeClaim?: string;    // default "type"
  rolesClaim?: string;   // default "roles"
  attrsClaims?: string[];
}
```

**Class: `JWTAuthenticator` implements `Authenticator`**
- Constructor: `(key, opts?: { algorithms?, audience?, issuer?, claimMapping?, requireClaims? })`
- `authenticate(headers): Identity | null` — extract Bearer token, decode JWT, map to Identity
- `securitySchemes(): Record<string, unknown>` — return bearerAuth scheme
- `decodeToken(token): JwtPayload | null` — decode with jsonwebtoken
- `payloadToIdentity(payload): Identity | null` — map claims

### `src/auth/middleware.ts`
Port of `apcore_a2a/auth/middleware.py`

**Function: `createAuthMiddleware(opts): express.RequestHandler`**
Express middleware that:
1. Checks exempt paths/prefixes
2. Calls `authenticator.authenticate(headers)`
3. On failure + requireAuth → 401 with `WWW-Authenticate: Bearer`
4. Wraps downstream in `authIdentityStore.run(identity, next)`

```typescript
interface AuthMiddlewareOptions {
  authenticator: Authenticator;
  exemptPaths?: Set<string>;
  exemptPrefixes?: Set<string>;
  requireAuth?: boolean; // default true
}
```

## TDD Tasks

### T-06.1: JWTAuthenticator
1. RED: test authenticate returns Identity for valid token
2. GREEN: implement authenticate + decodeToken
3. RED: test authenticate returns null for missing/invalid token
4. GREEN: add validation
5. RED: test custom ClaimMapping
6. GREEN: implement payloadToIdentity with mapping
7. RED: test securitySchemes returns bearer scheme
8. GREEN: implement securitySchemes

### T-06.2: AuthMiddleware
1. RED: test exempt paths bypass auth
2. GREEN: implement path checking
3. RED: test valid token sets identity in AsyncLocalStorage
4. GREEN: implement middleware with authIdentityStore.run()
5. RED: test invalid token returns 401
6. GREEN: add 401 response
7. RED: test exempt prefixes
8. GREEN: implement prefix matching
