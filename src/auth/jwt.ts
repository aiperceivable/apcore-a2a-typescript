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
    const authHeader = headers.authorization ?? headers.Authorization ?? "";
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
    const identityId = payload[mapping.idClaim];
    if (identityId == null) return null;

    const identityType = String(payload[mapping.typeClaim] ?? "user");
    const rawRoles = payload[mapping.rolesClaim];
    const roles = Array.isArray(rawRoles) ? rawRoles.map(String) : [];

    const attrs: Record<string, unknown> = {};
    for (const claim of mapping.attrsClaims) {
      if (claim in payload) attrs[claim] = payload[claim];
    }

    return createIdentity(String(identityId), identityType, roles, attrs);
  }
}
