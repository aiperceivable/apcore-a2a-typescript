import type { Request, Response, NextFunction } from "express";
import type { Authenticator } from "./types.js";
import { authIdentityStore } from "./storage.js";

export interface AuthMiddlewareOptions {
  authenticator: Authenticator;
  exemptPaths?: Set<string>;
  exemptPrefixes?: Set<string>;
  requireAuth?: boolean;
}

const DEFAULT_EXEMPT_PATHS = new Set([
  "/.well-known/agent-card.json",
  "/health",
  "/metrics",
]);

export function createAuthMiddleware(opts: AuthMiddlewareOptions) {
  const {
    authenticator,
    exemptPaths = DEFAULT_EXEMPT_PATHS,
    exemptPrefixes = new Set<string>(),
    requireAuth = true,
  } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;

    if (exemptPaths.has(path) || [...exemptPrefixes].some((p) => path.startsWith(p))) {
      next();
      return;
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
    }

    const identity = authenticator.authenticate(headers);

    if (identity === null && requireAuth) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({
        error: "Unauthorized",
        detail: "Missing or invalid Bearer token",
      });
      return;
    }

    authIdentityStore.run(identity, () => {
      next();
    });
  };
}
