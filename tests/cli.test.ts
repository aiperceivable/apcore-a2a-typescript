import { describe, it, expect, vi, afterEach } from "vitest";
import {
  failUsage,
  mergeOpenapiSettings,
  parseCliArgs,
  parseOpenapiHeaders,
  resolveAuthKey,
} from "../src/cli.js";
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

describe("parseOpenapiHeaders", () => {
  it("returns undefined when the flag was never given", () => {
    expect(parseOpenapiHeaders(undefined)).toBeUndefined();
    expect(parseOpenapiHeaders([])).toBeUndefined();
  });

  it("splits each repeated KEY:VALUE and trims both halves", () => {
    expect(parseOpenapiHeaders(["X-Api-Key: abc123", "Accept:application/json"])).toEqual({
      "X-Api-Key": "abc123",
      Accept: "application/json",
    });
  });

  it("keeps a colon inside the value", () => {
    // A header value is routinely a URL or a `Bearer x:y` pair; only the FIRST
    // colon separates.
    expect(parseOpenapiHeaders(["Referer: https://example.com/x"])).toEqual({
      Referer: "https://example.com/x",
    });
  });

  it("rejects an entry with no colon without echoing it", () => {
    // The flag may carry a credential, so the diagnostic must not repeat the
    // argument back into the terminal or a log.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("exit");
      }) as never);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => parseOpenapiHeaders(["not-a-header"])).toThrow("exit");
      expect(stderr.mock.calls.flat().join(" ")).not.toContain("not-a-header");
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it("rejects an empty or whitespace-only key, still without echoing it", () => {
    // A separator-index test alone is not the key test. `indexOf(":") <= 0`
    // rejects ":v" — the colon is at index 0 — but ACCEPTS " :v", where the
    // separator sits at index 1 and `.trim()` then yields an EMPTY header name,
    // producing a `{"": "v"}` entry that no HTTP client can send meaningfully.
    // Python checks `not key.strip()` and Rust `key.trim().is_empty()`; both
    // reject. The value half is a credential in every one of these, so the
    // no-echo requirement holds here exactly as it does above.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("exit");
      }) as never);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => parseOpenapiHeaders([" : super-secret-token"])).toThrow("exit");
      expect(() => parseOpenapiHeaders(["\t:super-secret-token"])).toThrow("exit");
      expect(() => parseOpenapiHeaders(["   :super-secret-token"])).toThrow("exit");
      // The index-0 case the original check did catch, kept so a fix cannot
      // regress it.
      expect(() => parseOpenapiHeaders([":super-secret-token"])).toThrow("exit");
      expect(stderr.mock.calls.flat().join(" ")).not.toContain("super-secret-token");
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Config Bus wiring (FR-OAS-004 AC 5) — the route must be reachable at all
// ---------------------------------------------------------------------------

describe("mergeOpenapiSettings", () => {
  const previousConfigFile = process.env.APCORE_CONFIG_FILE;

  afterEach(() => {
    if (previousConfigFile === undefined) delete process.env.APCORE_CONFIG_FILE;
    else process.env.APCORE_CONFIG_FILE = previousConfigFile;
  });

  /**
   * Point apcore's Config at a temp `apcore.yaml` carrying an
   * `apcore-a2a.openapi` section.
   *
   * The real Config is used rather than a stub: half of what this wiring has to
   * get right is that the *namespace read itself* works — a nested section under
   * a registered consumer namespace, reachable with no CLI flag — and a stubbed
   * `getA2aSetting` would assert only the half that is local to the CLI. JSON is
   * valid YAML, so the fixture is written with `JSON.stringify`.
   */
  function useConfig(openapi: Record<string, unknown> | null): void {
    const dir = mkdtempSync(join(tmpdir(), "cli-config-"));
    const file = join(dir, "apcore.yaml");
    writeFileSync(
      file,
      JSON.stringify(
        {
          apcore: { version: "1.0", project_name: "cli-fixture" },
          "apcore-a2a": openapi === null ? {} : { openapi },
        },
        null,
        2,
      ),
    );
    process.env.APCORE_CONFIG_FILE = file;
  }

  /** `mergeOpenapiSettings` narrowed to the mapping case every test but one wants. */
  async function merge(
    values: Record<string, string | boolean | (string | boolean)[] | undefined> = {},
  ): Promise<Record<string, unknown> | null> {
    return (await mergeOpenapiSettings(values)) as Record<string, unknown> | null;
  }

  it("reads a backend source from the Config Bus with no CLI flag at all", async () => {
    // Before this wiring `buildOpenapiBackendFromConfig` had no caller anywhere
    // in `src/`, so the section was documented and read by nothing: `timeout`,
    // `include`, `exclude` and `acknowledge_unapproved_writes` — none of which
    // has a CLI flag — were unreachable through any live path.
    useConfig({ spec: "./from-config.json", timeout: 5, prefix: "cfg" });

    const merged = await merge();

    expect(merged, "the Config Bus section was not consulted").not.toBeNull();
    expect(merged?.spec).toBe("./from-config.json");
    expect(merged?.timeout, "a key with no CLI flag must survive").toBe(5);
    expect(merged?.prefix).toBe("cfg");
  });

  it("lets an explicit flag beat the Config Bus per key", async () => {
    // Per key, not per source. Choosing the whole source by whoever named `spec`
    // would make `--openapi-prefix` a silent no-op alongside a config-declared
    // spec — the shape of the apcore-mcp `--openapi-header` defect this project
    // filed upstream as apcore-mcp-rust#8.
    useConfig({ spec: "./from-config.json", prefix: "cfg", timeout: 5 });

    const merged = await merge({ "openapi-prefix": "from-flag" });

    expect(merged?.prefix, "the flag must win").toBe("from-flag");
    expect(merged?.spec, "config keys with no flag survive").toBe("./from-config.json");
    expect(merged?.timeout).toBe(5);
  });

  it("does not let an absent --openapi-no-deprecated override the config", async () => {
    // The flag carries no `default: false` in the parseArgs config, for the same
    // reason the Python binding uses `default=None`: with a `false` default,
    // simply not passing it would overwrite a config `include_deprecated: false`
    // with `true` — an unpassed flag silently reversing a setting the operator
    // wrote down.
    useConfig({ spec: "./s.json", include_deprecated: false });

    const absent = await merge();
    expect(absent?.include_deprecated, "an absent flag must not override").toBe(false);

    const given = await merge({ "openapi-no-deprecated": true });
    expect(given?.include_deprecated).toBe(false);

    // ...and the flag, when passed, still overrides the opposite config value —
    // an implementation that fixed the absent case by never overlaying at all
    // would pass every assertion above.
    useConfig({ spec: "./s.json", include_deprecated: true });
    const flips = await merge({ "openapi-no-deprecated": true });
    expect(flips?.include_deprecated, "a passed flag must override").toBe(false);
  });

  it("keeps the absent-flag distinction across the real parseArgs table", async () => {
    // The other half of the same contract, and the half a `values` literal
    // cannot reach: `--openapi-no-deprecated` must arrive as `undefined` from
    // the flag table itself. Restoring the `default: false` the other booleans
    // carry would make the presence check above dead code, and every assertion
    // that stops at a hand-built `values` object would still pass.
    useConfig({ spec: "./s.json", include_deprecated: false });

    const absent = parseCliArgs(["serve", "--extensions-dir", "./ext"]);
    expect(absent.values["openapi-no-deprecated"]).toBeUndefined();
    expect((await merge(absent.values))?.include_deprecated).toBe(false);

    const given = parseCliArgs(["serve", "--openapi-no-deprecated"]);
    expect(given.values["openapi-no-deprecated"]).toBe(true);
  });

  it("returns null when no spec is named anywhere", async () => {
    delete process.env.APCORE_CONFIG_FILE;
    expect(await merge()).toBeNull();
    // The flag alone is still a source, with no config file in sight.
    expect((await merge({ "from-openapi": "./x.json" }))?.spec).toBe(
      "./x.json",
    );

    // A section with no `spec` is equally not a source: `prefix` alone cannot
    // start a backend, and treating the section's mere presence as one would
    // turn a partial config into a startup failure further down.
    useConfig({ prefix: "p" });
    expect(await merge()).toBeNull();
  });

  it("passes a non-mapping section through instead of discarding it", async () => {
    // `openapi: ./spec.json` — the mapping's one key written as the whole value
    // — is a typo, not an absence. Returning it unchanged lets
    // `buildOpenapiBackendFromConfig` name it ("apcore-a2a.openapi must be a
    // mapping."); discarding it would report "a backend source is required" and
    // send the operator hunting for a missing flag instead. This is the Rust
    // binding's behaviour; the Python reference discards.
    const file = join(mkdtempSync(join(tmpdir(), "cli-config-")), "apcore.yaml");
    writeFileSync(
      file,
      JSON.stringify({
        apcore: { version: "1.0", project_name: "cli-fixture" },
        "apcore-a2a": { openapi: "./spec.json" },
      }),
    );
    process.env.APCORE_CONFIG_FILE = file;

    expect(await mergeOpenapiSettings({})).toBe("./spec.json");

    // An explicit `openapi: null` is an absence, not a malformed mapping.
    useConfig(null);
    expect(await merge()).toBeNull();
  });
});

describe("exit codes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a usage fault exits 2, not 1", () => {
    // This SDK collapsed every error onto 1, losing a distinction Python's
    // argparse and Rust's clap each provide for free: exit 2 means the command
    // line is wrong and retrying it unchanged will always fail, while exit 1
    // means the environment it named is not ready and a retry may succeed. A
    // supervisor or CI job can act on that difference.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => failUsage("no backend source")).toThrow("exit:2");
    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith("Error: no backend source");
  });
});

describe("unknown arguments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureExit() {
    const messages: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: string) => void messages.push(m));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    return messages;
  }

  it("refuses a misspelled flag instead of silently ignoring it", () => {
    // Measured before this check: `--openapi-exclde 'secret.*'` put
    // `"openapi-exclde": true` in `values` and `"secret.*"` in `positionals`, so
    // the exclusion silently did not apply and every operation it was meant to
    // hold back was published to the PUBLIC Agent Card — a route served without
    // authentication. The server started and reported success.
    const messages = captureExit();
    expect(() =>
      parseCliArgs(["serve", "--extensions-dir", "./ext", "--openapi-exclde", "secret.*"]),
    ).toThrow("exit:2");
    expect(messages.join("\n")).toContain("--openapi-exclde");
  });

  it("refuses a stray positional", () => {
    // The other side of the same mistake: a misspelled flag's VALUE lands here,
    // so reporting only the flag would leave the operator hunting for it.
    const messages = captureExit();
    expect(() => parseCliArgs(["serve", "leftover"])).toThrow("exit:2");
    expect(messages.join("\n")).toContain("leftover");
  });

  it("accepts every flag the table defines", () => {
    // The check must not reject the CLI's own surface. `--metrics=x` and a
    // repeated non-multiple option stay tolerated: that is what `strict: false`
    // is kept for, and this check deliberately does not extend to them.
    expect(() =>
      parseCliArgs([
        "serve",
        "--extensions-dir",
        "./ext",
        "--openapi-prefix",
        "pets",
        "--openapi-header",
        "K: V",
        "--openapi-no-deprecated",
        "--metrics",
        "--port",
        "9000",
      ]),
    ).not.toThrow();
  });
});
