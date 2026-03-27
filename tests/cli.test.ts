import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveAuthKey } from "../src/cli.js";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveAuthKey", () => {
  let tempDir: string;
  let tempFile: string;

  afterEach(() => {
    try {
      if (tempFile) unlinkSync(tempFile);
    } catch {
      // ignore
    }
    delete process.env.APCORE_JWT_SECRET;
  });

  it("reads from file when path exists", () => {
    tempDir = mkdtempSync(join(tmpdir(), "cli-test-"));
    tempFile = join(tempDir, "secret.key");
    writeFileSync(tempFile, "  my-secret-from-file  \n");

    const result = resolveAuthKey(tempFile);
    expect(result).toBe("my-secret-from-file");
  });

  it("returns literal string when not a file", () => {
    const result = resolveAuthKey("literal-secret");
    expect(result).toBe("literal-secret");
  });

  it("falls back to APCORE_JWT_SECRET env var when no key provided", () => {
    process.env.APCORE_JWT_SECRET = "env-secret";
    const result = resolveAuthKey();
    expect(result).toBe("env-secret");
  });

  it("returns undefined when nothing is available", () => {
    const result = resolveAuthKey();
    expect(result).toBeUndefined();
  });
});
