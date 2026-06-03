/** Conformance — Algorithm A-AUTH: JWT claim -> Identity coercion parity. */
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWTAuthenticator } from "../../src/auth/jwt.js";
import { loadFixture } from "./_spec.js";

const fixture = loadFixture("jwt_claim_coercion.json");
const SECRET: string = fixture?.secret ?? "";
const ALG = (fixture?.algorithm ?? "HS256") as jwt.Algorithm;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function headersFor(c: any): Record<string, string> {
  if (c.headers) return c.headers;
  const claims = { ...c.claims };
  if ("exp_offset_seconds" in claims) {
    claims.exp = Math.floor(Date.now() / 1000) + claims.exp_offset_seconds;
    delete claims.exp_offset_seconds;
  }
  const secret = c.sign_with_secret ?? SECRET;
  const token = jwt.sign(claims, secret, { algorithm: ALG });
  return { authorization: `Bearer ${token}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function authenticate(c: any) {
  return new JWTAuthenticator(SECRET, { algorithms: [ALG] }).authenticate(headersFor(c));
}

(fixture ? describe : describe.skip)("A-AUTH: jwt claim coercion", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.test_cases ?? []) {
    it(`accepts ${c.id}`, () => {
      const id = authenticate(c);
      expect(id, c.id).not.toBeNull();
      expect(id!.id).toBe(c.expected_identity.id);
      expect(id!.type).toBe(c.expected_identity.type);
      expect([...(id!.roles ?? [])]).toEqual(c.expected_identity.roles);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.reject_cases ?? []) {
    it(`rejects ${c.id}`, () => {
      expect(authenticate(c)).toBeNull();
    });
  }
});
