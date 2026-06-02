import jwt from "jsonwebtoken";
import { createIdentity, type Identity } from "apcore-js";
import type { Authenticator } from "./types.js";

export interface ClaimMapping {
  idClaim?: string;
  typeClaim?: string;
  rolesClaim?: string;
  attrsClaims?: string[];
}

export interface JWTAuthenticatorOptions {
  algorithms?: jwt.Algorithm[];
  audience?: string;
  issuer?: string;
  claimMapping?: ClaimMapping;
  requireClaims?: string[];
}

/**
 * Coerce a JWT claim value to a string using the canonical cross-language rule.
 *
 * Mirrors the Rust SDK's `claim_to_string` (the agreed-upon canonical behaviour):
 * strings pass through, numbers and booleans are stringified, and null/arrays/objects
 * are rejected (return null). Keeps the three SDKs in agreement on whether a malformed
 * (non-scalar) claim is accepted and on the exact string an accepted claim produces.
 */
function claimToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export class JWTAuthenticator implements Authenticator {
  private key: string;
  private algorithms: jwt.Algorithm[];
  private audience?: string;
  private issuer?: string;
  private claimMapping: Required<ClaimMapping>;
  private requireClaims: string[];

  constructor(key: string, opts?: JWTAuthenticatorOptions) {
    this.key = key;
    this.algorithms = opts?.algorithms ?? ["HS256"];
    this.audience = opts?.audience;
    this.issuer = opts?.issuer;
    this.claimMapping = {
      idClaim: opts?.claimMapping?.idClaim ?? "sub",
      typeClaim: opts?.claimMapping?.typeClaim ?? "type",
      rolesClaim: opts?.claimMapping?.rolesClaim ?? "roles",
      attrsClaims: opts?.claimMapping?.attrsClaims ?? [],
    };
    this.requireClaims = opts?.requireClaims ?? ["sub"];
  }

  authenticate(headers: Record<string, string>): Identity | null {
    const authHeader = headers.authorization ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) return null;

    const token = authHeader.slice(7).trim();
    if (!token) return null;

    const payload = this.decodeToken(token);
    if (!payload) return null;

    return this.payloadToIdentity(payload);
  }

  securitySchemes(): Record<string, unknown> {
    return { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } };
  }

  private decodeToken(token: string): Record<string, unknown> | null {
    try {
      const opts: jwt.VerifyOptions = {
        algorithms: this.algorithms,
      };
      if (this.audience) opts.audience = this.audience;
      if (this.issuer) opts.issuer = this.issuer;

      const payload = jwt.verify(token, this.key, opts);
      if (typeof payload === "string") return null;

      for (const claim of this.requireClaims) {
        if (!(claim in payload)) return null;
      }

      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private payloadToIdentity(payload: Record<string, unknown>): Identity | null {
    const mapping = this.claimMapping;
    // The id claim must coerce to a scalar string, or the token is rejected
    // (canonical rule: a non-scalar `sub` is not a valid identity id).
    const id = claimToString(payload[mapping.idClaim]);
    if (id === null) return null;

    // Only an absent/null/non-scalar type falls back to "user"; an explicit
    // empty-string type is preserved (parity with Rust unwrap_or_else / Python).
    const identityType = claimToString(payload[mapping.typeClaim]) ?? "user";
    const rawRoles = payload[mapping.rolesClaim];
    const roles = Array.isArray(rawRoles)
      ? rawRoles.map(claimToString).filter((r): r is string => r !== null)
      : [];

    const attrs: Record<string, unknown> = {};
    for (const claim of mapping.attrsClaims) {
      if (claim in payload) attrs[claim] = payload[claim];
    }

    return createIdentity(id, identityType, roles, attrs);
  }
}
