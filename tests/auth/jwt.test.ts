import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWTAuthenticator } from "../../src/auth/jwt.js";

const SECRET = "test-secret-key-for-jwt";

function makeToken(
  payload: Record<string, unknown>,
  key = SECRET,
  opts?: jwt.SignOptions,
): string {
  return jwt.sign(payload, key, { algorithm: "HS256", ...opts });
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("JWTAuthenticator", () => {
  describe("authenticate", () => {
    it("returns Identity for valid token with sub claim", () => {
      const auth = new JWTAuthenticator(SECRET);
      const token = makeToken({ sub: "user-1" });
      const identity = auth.authenticate(headers(token));

      expect(identity).not.toBeNull();
      expect(identity!.id).toBe("user-1");
      expect(identity!.type).toBe("user");
    });

    it("returns null for missing Authorization header", () => {
      const auth = new JWTAuthenticator(SECRET);
      expect(auth.authenticate({})).toBeNull();
    });

    it("returns null for non-Bearer scheme", () => {
      const auth = new JWTAuthenticator(SECRET);
      expect(auth.authenticate({ authorization: "Basic abc123" })).toBeNull();
    });

    it("returns null for empty Bearer token", () => {
      const auth = new JWTAuthenticator(SECRET);
      expect(auth.authenticate({ authorization: "Bearer " })).toBeNull();
    });

    it("returns null for invalid token", () => {
      const auth = new JWTAuthenticator(SECRET);
      expect(auth.authenticate(headers("not-a-jwt"))).toBeNull();
    });

    it("returns null for wrong signing key", () => {
      const auth = new JWTAuthenticator(SECRET);
      const token = makeToken({ sub: "user-1" }, "wrong-key");
      expect(auth.authenticate(headers(token))).toBeNull();
    });

    it("returns null for expired token", () => {
      const auth = new JWTAuthenticator(SECRET);
      const token = makeToken({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 });
      expect(auth.authenticate(headers(token))).toBeNull();
    });

    it("returns null when required claim is missing", () => {
      const auth = new JWTAuthenticator(SECRET, { requireClaims: ["sub", "org"] });
      const token = makeToken({ sub: "user-1" });
      expect(auth.authenticate(headers(token))).toBeNull();
    });

    it("handles case-insensitive Authorization header", () => {
      const auth = new JWTAuthenticator(SECRET);
      const token = makeToken({ sub: "user-1" });
      const identity = auth.authenticate({ Authorization: `Bearer ${token}` });
      expect(identity).not.toBeNull();
      expect(identity!.id).toBe("user-1");
    });
  });

  describe("custom ClaimMapping", () => {
    it("maps custom id claim", () => {
      const auth = new JWTAuthenticator(SECRET, {
        claimMapping: { idClaim: "user_id" },
      });
      const token = makeToken({ sub: "ignored", user_id: "custom-42" });
      const identity = auth.authenticate(headers(token));
      expect(identity!.id).toBe("custom-42");
    });

    it("maps custom type claim", () => {
      const auth = new JWTAuthenticator(SECRET, {
        claimMapping: { typeClaim: "account_type" },
      });
      const token = makeToken({ sub: "user-1", account_type: "service" });
      const identity = auth.authenticate(headers(token));
      expect(identity!.type).toBe("service");
    });

    it("maps roles from custom claim", () => {
      const auth = new JWTAuthenticator(SECRET, {
        claimMapping: { rolesClaim: "permissions" },
      });
      const token = makeToken({ sub: "user-1", permissions: ["admin", "editor"] });
      const identity = auth.authenticate(headers(token));
      expect(identity!.roles).toEqual(["admin", "editor"]);
    });

    it("maps attrs from specified claims", () => {
      const auth = new JWTAuthenticator(SECRET, {
        claimMapping: { attrsClaims: ["org", "team"] },
      });
      const token = makeToken({ sub: "user-1", org: "acme", team: "eng" });
      const identity = auth.authenticate(headers(token));
      expect(identity!.attrs).toEqual({ org: "acme", team: "eng" });
    });

    it("defaults type to 'user' when type claim absent", () => {
      const auth = new JWTAuthenticator(SECRET);
      const token = makeToken({ sub: "user-1" });
      const identity = auth.authenticate(headers(token));
      expect(identity!.type).toBe("user");
    });

    it("returns empty roles when roles claim is not an array", () => {
      const auth = new JWTAuthenticator(SECRET);
      const token = makeToken({ sub: "user-1", roles: "admin" });
      const identity = auth.authenticate(headers(token));
      expect(identity!.roles).toEqual([]);
    });
  });

  describe("audience and issuer validation", () => {
    it("rejects token with wrong audience", () => {
      const auth = new JWTAuthenticator(SECRET, { audience: "my-app" });
      const token = makeToken({ sub: "user-1", aud: "other-app" });
      expect(auth.authenticate(headers(token))).toBeNull();
    });

    it("accepts token with correct audience", () => {
      const auth = new JWTAuthenticator(SECRET, { audience: "my-app" });
      const token = makeToken({ sub: "user-1" }, SECRET, { audience: "my-app" });
      const identity = auth.authenticate(headers(token));
      expect(identity).not.toBeNull();
    });

    it("rejects token with wrong issuer", () => {
      const auth = new JWTAuthenticator(SECRET, { issuer: "my-issuer" });
      const token = makeToken({ sub: "user-1", iss: "other-issuer" });
      expect(auth.authenticate(headers(token))).toBeNull();
    });
  });

  describe("securitySchemes", () => {
    it("returns bearer auth scheme", () => {
      const auth = new JWTAuthenticator(SECRET);
      const schemes = auth.securitySchemes();
      expect(schemes).toEqual({
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      });
    });
  });
});
