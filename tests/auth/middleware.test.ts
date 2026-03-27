import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware } from "../../src/auth/middleware.js";
import { authIdentityStore } from "../../src/auth/storage.js";
import type { Authenticator } from "../../src/auth/types.js";
import type { Identity } from "apcore-js";

function makeReq(path: string, authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  return {
    path,
    headers,
  } as unknown as Request;
}

function makeRes(): Response & { statusCode: number; body: unknown; headersSent: Record<string, string> } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headersSent: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(key: string, value: string) {
      res.headersSent[key] = value;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as Response & typeof res;
}

function makeIdentity(id: string): Identity {
  return { id, type: "user", roles: [], attrs: {} } as Identity;
}

function makeAuthenticator(result: Identity | null): Authenticator {
  return {
    authenticate: vi.fn().mockReturnValue(result),
    securitySchemes: () => ({}),
  };
}

describe("createAuthMiddleware", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  describe("exempt paths", () => {
    it("bypasses auth for default exempt paths", () => {
      const authenticator = makeAuthenticator(null);
      const middleware = createAuthMiddleware({ authenticator });

      for (const path of ["/.well-known/agent.json", "/health", "/metrics"]) {
        const req = makeReq(path);
        const res = makeRes();
        middleware(req, res, next);
      }

      expect(next).toHaveBeenCalledTimes(3);
      expect(authenticator.authenticate).not.toHaveBeenCalled();
    });

    it("bypasses auth for custom exempt paths", () => {
      const authenticator = makeAuthenticator(null);
      const middleware = createAuthMiddleware({
        authenticator,
        exemptPaths: new Set(["/public"]),
      });

      middleware(makeReq("/public"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("bypasses auth for exempt prefixes", () => {
      const authenticator = makeAuthenticator(null);
      const middleware = createAuthMiddleware({
        authenticator,
        exemptPrefixes: new Set(["/api/public"]),
      });

      middleware(makeReq("/api/public/data"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("authentication", () => {
    it("returns 401 when auth fails and requireAuth is true", () => {
      const middleware = createAuthMiddleware({
        authenticator: makeAuthenticator(null),
      });

      const res = makeRes();
      middleware(makeReq("/api/task"), res, next);

      expect(res.statusCode).toBe(401);
      expect(res.headersSent["WWW-Authenticate"]).toBe("Bearer");
      expect(res.body).toEqual({
        error: "Unauthorized",
        detail: "Missing or invalid Bearer token",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("calls next when auth fails but requireAuth is false", () => {
      const middleware = createAuthMiddleware({
        authenticator: makeAuthenticator(null),
        requireAuth: false,
      });

      middleware(makeReq("/api/task"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("sets identity in AsyncLocalStorage on successful auth", () => {
      const identity = makeIdentity("user-1");
      const middleware = createAuthMiddleware({
        authenticator: makeAuthenticator(identity),
      });

      let capturedIdentity: Identity | null = null;
      const captureNext: NextFunction = () => {
        capturedIdentity = authIdentityStore.getStore() ?? null;
      };

      middleware(makeReq("/api/task", "Bearer valid-token"), makeRes(), captureNext);
      expect(capturedIdentity).toEqual(identity);
    });

    it("passes headers to authenticator", () => {
      const authenticator = makeAuthenticator(null);
      const middleware = createAuthMiddleware({ authenticator, requireAuth: false });

      const req = makeReq("/api/task", "Bearer my-token");
      middleware(req, makeRes(), next);

      expect(authenticator.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ authorization: "Bearer my-token" }),
      );
    });
  });
});
