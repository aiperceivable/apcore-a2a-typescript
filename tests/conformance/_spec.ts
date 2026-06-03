/**
 * Shared helpers for the cross-language conformance runners (Algorithm A01).
 *
 * Fixtures live in the apcore-a2a spec repo at conformance/fixtures/*.json and
 * are shared verbatim with the Python and Rust SDK runners. The spec repo is
 * resolved from APCORE_A2A_SPEC_REPO (set by CI), defaulting to the sibling
 * ../apcore-a2a checkout. When the fixtures are absent the runners skip.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_REPO_ROOT =
  process.env.APCORE_A2A_SPEC_REPO ?? path.resolve(dir, "../../../apcore-a2a");
const FIXTURES_DIR = path.join(SPEC_REPO_ROOT, "conformance", "fixtures");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadFixture(name: string): any | null {
  const p = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** Deep partial match: every key/value in `expected` must appear in `actual`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function partialMatch(expected: any, actual: any, p = ""): string | null {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return `${p || "<root>"}: expected object, got ${JSON.stringify(actual)}`;
    }
    for (const [k, v] of Object.entries(expected)) {
      const sub = p ? `${p}.${k}` : k;
      if (!(k in actual)) return `${sub}: missing key (have ${Object.keys(actual)})`;
      const err = partialMatch(v, actual[k], sub);
      if (err) return err;
    }
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${p}: expected array`;
    if (actual.length < expected.length) {
      return `${p}: expected >= ${expected.length} items, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const err = partialMatch(expected[i], actual[i], `${p}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (expected !== actual) {
    return `${p || "<root>"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  return null;
}
