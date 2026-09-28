/**
 * Conformance — Algorithm A-OAS: OpenAPI backend parity (feature F-12).
 *
 * Fixture: `conformance/fixtures/openapi_backend.json` in the apcore-a2a spec
 * repo, shared verbatim with the Python and Rust runners. Builds a Registry from
 * each document through `openapiBackend` and asserts the registered module set,
 * the repaired descriptions, the emitted diagnostics, the resulting Agent Card
 * and the failure modes.
 *
 * The scanner's own derivation — including the normalisation of every module ID
 * into apcore's Canonical ID alphabet (apcore-toolkit >= 0.13.0) — is pinned by
 * apcore-toolkit's 33-case corpus, not here. What this driver checks is
 * everything the binding adds on top: registering the emitted ID and skipping
 * the ones apcore's registry would still reject (FR-OAS-002), the
 * empty-description repair (FR-OAS-003), the path-typed spec key (FR-OAS-004),
 * the unapproved-write warning (FR-OAS-005) and the collision preflight
 * (FR-OAS-006).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { ACL, FunctionModule, Registry, createIdentity } from "apcore-js";
import { cloneModule, type ScannedModule } from "apcore-toolkit";
import type { AgentCard } from "@a2a-js/sdk";
import { AgentCardBuilder } from "../../src/adapters/agent-card.js";
import { SkillMapper } from "../../src/adapters/skill-mapper.js";
import {
  buildExtendedCard,
  buildPublicCard,
  type RegistryLike,
} from "../../src/adapters/card-visibility.js";
import {
  buildOpenapiBackendFromConfig,
  openapiBackend,
  projectModuleId,
  resolveProjectRoot,
  synthesizeDescription,
  resolveSpecLocation,
  type OpenapiBackendOptions,
} from "../../src/openapi-backend.js";
import { loadFixture } from "./_spec.js";

const fixture = loadFixture("openapi_backend.json");

/**
 * The fixture asserts annotations against apcore's own field names, spelled
 * snake_case; apcore-js spells the same fields camelCase. Never a
 * transport-specific projection — apcore-mcp's fixture asserts MCP hint names
 * and that column has no A2A counterpart.
 */
const ANNOTATION_FIELD: Readonly<Record<string, string>> = {
  readonly: "readonly",
  destructive: "destructive",
  idempotent: "idempotent",
  open_world: "openWorld",
  requires_approval: "requiresApproval",
};

/** A capturing logger — the injectable sink is what makes the text assertable. */
function recorder() {
  const warn: string[] = [];
  const error: string[] = [];
  const info: string[] = [];
  return {
    warn: (m: string) => void warn.push(m),
    error: (m: string) => void error.push(m),
    info: (m: string) => void info.push(m),
    warnings: () => warn.join("\n"),
    errors: () => [...error],
    infos: () => info.join("\n"),
    /** The FR-OAS-003 report line itself — never the whole INFO buffer. */
    synthesisLines: () => info.filter((line) => line.includes("synthesized")),
    all: () => [...warn, ...error, ...info].join("\n"),
  };
}

/**
 * Hooks the fixture names by `hooks.transform_module`, implemented here. The
 * fixture's notes define each one.
 */
const TRANSFORM_MODULE_HOOKS: Readonly<
  Record<string, (module: ScannedModule) => ScannedModule | null>
> = {
  rename_to_mixed_case_id: (module) => cloneModule(module, { moduleId: "MyThing" }),
};

/**
 * Backend options for the hooks a case names. An unknown name fails the case:
 * ignoring it would silently run the hook-free path and pass a case that
 * asserts what a hook does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hookOptionsFor(testCase: any): Partial<OpenapiBackendOptions> {
  const { transform_module: transformModule, ...unknown } = testCase.hooks ?? {};
  if (Object.keys(unknown).length > 0) {
    throw new Error(
      `${testCase.id}: the fixture names hooks this driver does not implement: ` +
        Object.keys(unknown).sort().join(", "),
    );
  }
  if (transformModule === undefined) return {};
  const hook = TRANSFORM_MODULE_HOOKS[transformModule];
  if (!hook) {
    throw new Error(
      `${testCase.id}: the fixture names a transform_module hook this driver lacks: ` +
        transformModule,
    );
  }
  return { transformModule: hook };
}

/** Translate a fixture `options` block (snake_case) into backend options. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function optionsFor(testCase: any, log: ReturnType<typeof recorder>): OpenapiBackendOptions {
  const raw = testCase.options ?? {};
  return {
    ...hookOptionsFor(testCase),
    prefix: raw.prefix,
    // Forwarded, never defaulted. `no_base_url_anywhere_rejected` asserts the
    // failure when it is absent from both the options and the document, and
    // `base_url_option_supplies_what_the_document_lacks` asserts it is honoured
    // when the document has no `servers` — a key this mapping originally omitted,
    // which no case could detect until that second one existed.
    baseUrl: raw.base_url,
    include: raw.include,
    exclude: raw.exclude,
    includeDeprecated: raw.include_deprecated ?? true,
    acknowledgeUnapprovedWrites: raw.acknowledge_unapproved_writes ?? false,
    // The fixture spells a pseudo-option that names the *situation*, not an
    // argument: "an extensions directory is also configured".
    hasOtherBackendSource: raw.additional_backend_source ?? false,
    logger: log,
  };
}

function registryIds(registry: Registry): string[] {
  return [...registry.list({ visibility: ["public", "hidden"] })].sort();
}

function cardFor(registry: Registry): AgentCard {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AgentCardBuilder(new SkillMapper()).build(registry as any, {
    name: "openapi-agent",
    description: "An agent built from an OpenAPI document",
    version: "1.0.0",
    url: "http://localhost:8000",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    capabilities: { streaming: false, pushNotifications: false, extensions: [] } as any,
  }) as AgentCard;
}

const skillIds = (card: AgentCard): string[] => (card.skills ?? []).map((s) => s.id).sort();

/** A minimal registered module, so a collision has something to collide with. */
function registerStub(registry: Registry, moduleId: string): void {
  void registry.register(
    moduleId,
    new FunctionModule({
      execute: () => ({}),
      moduleId,
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      description: `stub ${moduleId}`,
    }),
  );
}

/**
 * Every case in one fixture group.
 *
 * **Throws on a missing or empty group rather than returning `[]`.** A
 * `fixture?.group ?? []` makes the whole suite pass vacuously the moment a group
 * is renamed in the spec repo: the loop iterates zero cases and vitest reports
 * success, which is the failure mode this suite exists to prevent. Measured —
 * renaming `test_cases` dropped this file from 46 passing tests to 33 with no
 * failure, while apcore-a2a-python failed loudly on the same mutation because it
 * indexes the key directly.
 *
 * The absent-fixture case is handled separately by `describe.skip` above: not
 * having the spec repo checked out is legitimate, having it with the wrong shape
 * is not.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cases(group: string): any[] {
  const found = fixture?.[group];
  if (!Array.isArray(found)) {
    throw new Error(
      `conformance fixture has no \`${group}\` array — the group was renamed or ` +
        "removed. Refusing to pass vacuously.",
    );
  }
  if (found.length === 0) {
    throw new Error(
      `conformance fixture group \`${group}\` is empty — refusing to pass vacuously.`,
    );
  }
  return found;
}

// --------------------------------------------------------------------------
// test_cases — document -> registered modules
// --------------------------------------------------------------------------

(fixture ? describe : describe.skip)("A-OAS: openapi backend", () => {
  for (const c of cases("test_cases")) {
    it(c.id, async () => {
      const log = recorder();
      const registry = await openapiBackend(c.document, optionsFor(c, log));

      expect(registryIds(registry)).toEqual(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [...c.expected_modules.map((m: any) => m.module_id)].sort(),
      );

      for (const spec of c.expected_modules) {
        const definition = registry.getDefinition(spec.module_id);
        expect(definition, `${spec.module_id} not registered`).not.toBeNull();
        expect(definition?.description).toBe(spec.description);

        for (const [field, want] of Object.entries(spec.annotations ?? {})) {
          const key = ANNOTATION_FIELD[field] ?? field;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const got = (definition?.annotations as any)?.[key];
          expect(got, `${spec.module_id}.${field}`).toBe(want);
        }

        // A scanner warning must reach the operator: the backend re-emits every
        // per-module warning rather than leaving it on the ScannedModule where
        // nothing reads it.
        if (spec.warnings_contain) {
          expect(log.warnings()).toContain(spec.warnings_contain);
          expect(log.warnings()).toContain(spec.module_id);
        }
      }

      // A skipped operation must be reported at WARNING, naming the emitted ID
      // and — in its own right, not only as a substring of the ID — the
      // offending segment. An implementation that silently drops it fails here.
      for (const drop of c.expected_dropped ?? []) {
        const line = log
          .warnings()
          .split("\n")
          .find((w) => w.includes(drop.derived_id));
        expect(line, `no WARNING names the skipped id ${drop.derived_id}`).toBeDefined();
        expect(String(line).replace(drop.derived_id, "")).toContain(drop.offending_segment);
      }
      for (const substring of c.expected_warning_substrings ?? []) {
        expect(log.warnings()).toContain(substring);
      }
      // Skipping an illegal ID before the writer, not leaving apcore's registry
      // to reject it: the rejection also leaves it unregistered, but as an ERROR.
      if (c.expected_no_error_logs) {
        expect(log.errors(), "expected no ERROR lines").toEqual([]);
      }

      // The FR-OAS-003 point is the Agent Card, not the registry: assert the
      // skill actually reaches it. AgentCardBuilder trims before testing, so a
      // whitespace-only description is skipped exactly like an absent one.
      const onCard = c.expected_on_agent_card ?? [];
      if (onCard.length > 0) {
        const ids = skillIds(cardFor(registry));
        for (const moduleId of onCard) {
          expect(ids, `${moduleId} missing from the Agent Card`).toContain(moduleId);
        }
      }
    });
  }

  // ------------------------------------------------------------------------
  // FR-OAS-003 — the INFO line must name every repaired operation
  // ------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repairCases = cases("test_cases").filter((c: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.expected_modules ?? []).some((m: any) => "description_was_synthesized" in m),
  );

  for (const c of repairCases) {
    it(`${c.id} (description-repair diagnostic)`, async () => {
      const log = recorder();
      const registry = await openapiBackend(c.document, optionsFor(c, log));

      // Scoped to the synthesis line itself: apcore-toolkit's writer may log its
      // own "Registered HTTP proxy: <id>" line, so a whole-buffer search would
      // find every id whatever the report said.
      const synthesis = log.synthesisLines();
      for (const spec of c.expected_modules) {
        if (!("description_was_synthesized" in spec)) continue;
        if (spec.description_was_synthesized) {
          expect(synthesis, "expected exactly one synthesis INFO line").toHaveLength(1);
          // The EMITTED id — dedup suffix included — and only that one: a
          // diagnostic naming any other id sends the operator looking for a
          // skill that does not exist.
          expect(synthesis[0]).toContain(spec.module_id);
        } else {
          expect(synthesis).toEqual([]);
        }
        expect(registry.getDefinition(spec.module_id)?.description).toBe(spec.description);
      }
      for (const needle of c.expected_synthesis_report?.contains ?? []) {
        expect(synthesis[0], `the synthesis report lacks ${needle}`).toContain(needle);
      }
      for (const needle of c.expected_synthesis_report?.excludes ?? []) {
        expect(synthesis[0], `the synthesis report names ${needle}`).not.toContain(needle);
      }
    });
  }

  // ------------------------------------------------------------------------
  // warning_cases — FR-OAS-005
  // ------------------------------------------------------------------------

  for (const c of cases("warning_cases")) {
    it(c.id, async () => {
      const log = recorder();
      await openapiBackend(c.document, optionsFor(c, log));

      const warnings = log.warnings();
      const fired = warnings.includes("PUBLIC Agent Card");
      expect(fired, `expected warning=${c.expect_warning}, got:\n${warnings}`).toBe(
        c.expect_warning,
      );
      for (const substring of c.expected_warning_substrings ?? []) {
        expect(warnings.toLowerCase()).toContain(String(substring).toLowerCase());
      }
    });
  }

  it("write warning is not suppressed by a permissive ACL (discriminating)", async () => {
    // apcore's own GovernanceState.unprotectedControlSurface states the rule
    // this follows: it reports the ABSENCE OF A GATE, never the presence of
    // protection — a wired ACL that permits every call still yields false. An
    // implementation that gates the warning on governanceState().aclConfigured
    // passes every other case in this group and fails this one.
    const c = fixture.warning_cases.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w: any) => w.id === "write_warning_not_suppressed_by_permissive_acl",
    );
    expect(c.acl.default_effect).toBe("allow");

    const log = recorder();
    await openapiBackend(c.document, {
      ...optionsFor(c, log),
      // Everything an "an ACL is attached" predicate would read, all true.
      governanceState: {
        aclConfigured: true,
        builtinAclGateWired: true,
        approvalHandlerConfigured: true,
        builtinApprovalGateWired: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    expect(log.warnings()).toContain("PUBLIC Agent Card");
  });

  it("escalates the wording when the approval gate is not in the pipeline", async () => {
    // Under the `internal`, `testing` and `minimal` strategies neither a module
    // annotation nor an ACL rule's `approval: required` would fire at all.
    const c = fixture.warning_cases.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w: any) => w.id === "write_warning_fires_for_each_write_method",
    );
    const log = recorder();
    await openapiBackend(c.document, {
      ...optionsFor(c, log),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      governanceState: { builtinApprovalGateWired: false } as any,
    });
    expect(log.warnings()).toContain("NOT in the execution pipeline");
    expect(log.warnings()).toContain("PUBLIC Agent Card");
  });

  // ------------------------------------------------------------------------
  // config_cases — FR-OAS-004
  // ------------------------------------------------------------------------

  for (const c of cases("config_cases")) {
    it(c.id, () => {
      // The differing cwd is what makes this case assert anything: a resolver
      // that used the process CWD would produce a different answer here.
      expect(process.cwd()).not.toBe(c.project_root);

      const log = recorder();
      let resolved = resolveSpecLocation(c.spec_value, {
        projectRoot: c.project_root,
        logger: log,
      });
      if (resolved === null && c.spec_value_next_tier !== undefined) {
        resolved = resolveSpecLocation(c.spec_value_next_tier, {
          projectRoot: c.project_root,
          logger: log,
        });
      }

      expect(resolved).toBe(c.expected_resolved_spec);
      if (c.expected_warning_substring) {
        expect(log.warnings()).toContain(c.expected_warning_substring);
      }
    });
  }

  it("reads Config.projectRoot for the resolution base, not the process CWD", () => {
    // FR-OAS-004 rule 3 at the accessor level. `Config.projectRoot` is apcore
    // 0.30.0's public accessor and carries no resolution behaviour of its own —
    // it reports the base and this binding applies it.
    const projectRoot = mkdtempSync(join(tmpdir(), "a2a-oas-base-"));
    writeFileSync(
      join(projectRoot, "apcore.yaml"),
      "apcore:\n  version: '1.0'\n  project_name: oas-fixture\n",
    );
    const previous = process.env.APCORE_CONFIG_FILE;
    process.env.APCORE_CONFIG_FILE = join(projectRoot, "apcore.yaml");
    try {
      expect(resolveProjectRoot(null)).toBe(projectRoot);
      expect(resolveProjectRoot(null)).not.toBe(process.cwd());
      // An explicit base always wins; nothing is consulted.
      expect(resolveProjectRoot("/srv/project")).toBe("/srv/project");
    } finally {
      if (previous === undefined) delete process.env.APCORE_CONFIG_FILE;
      else process.env.APCORE_CONFIG_FILE = previous;
    }
  });

  it("resolves a relative spec against Config.projectRoot on the Config Bus route", async () => {
    // FR-OAS-004 rule 3 on the one route most deployments use. apcore-mcp's
    // TypeScript and Rust config routes leave projectRoot unset, so a relative
    // spec silently resolves against the CWD; the document below exists ONLY
    // under the project root, so a CWD-resolving implementation cannot load it.
    const projectRoot = mkdtempSync(join(tmpdir(), "a2a-oas-root-"));
    writeFileSync(
      join(projectRoot, "apcore.yaml"),
      "apcore:\n  version: '1.0'\n  project_name: oas-fixture\n",
    );
    writeFileSync(
      join(projectRoot, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Pets", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    );

    const previous = process.env.APCORE_CONFIG_FILE;
    process.env.APCORE_CONFIG_FILE = join(projectRoot, "apcore.yaml");
    try {
      expect(process.cwd()).not.toBe(projectRoot);
      const log = recorder();
      const registry = await buildOpenapiBackendFromConfig(
        { spec: "./openapi.json" },
        { logger: log },
      );
      expect(registry).not.toBeNull();
      expect(registryIds(registry as Registry)).toEqual(["list_pets"]);
    } finally {
      if (previous === undefined) delete process.env.APCORE_CONFIG_FILE;
      else process.env.APCORE_CONFIG_FILE = previous;
    }
  });

  it("passes the spec-fetch timeout to loadSpec in MILLISECONDS, and threads headers", async () => {
    // apcore-toolkit's `LoadSpecOptions.timeout` is in MILLISECONDS (default
    // 30_000) while the Config Bus key is documented in SECONDS. apcore-mcp's
    // TypeScript backend passes the seconds value straight through, so a
    // documented `timeout: 30` becomes a 30 MS fetch timeout. The server below
    // answers after a deliberate delay: an implementation that forgot the
    // conversion aborts the fetch and fails this test.
    //
    // It also asserts the second half of the contract — `headers` reach the spec
    // fetch (apcore-mcp's Rust build drops them silently) and never appear in a
    // diagnostic, because they are credentials.
    const document = {
      openapi: "3.0.3",
      info: { title: "Pets", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };

    let seenApiKey: string | undefined;
    const server = createServer((req, res) => {
      seenApiKey = req.headers["x-api-key"] as string | undefined;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(document));
      }, 150);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const log = recorder();
    try {
      const registry = await openapiBackend(`http://127.0.0.1:${port}/openapi.json`, {
        // 5 SECONDS. Straight through it would be 5 ms, and 150 ms of latency
        // would abort the fetch.
        timeout: 5,
        headers: { "X-Api-Key": "spec-read-secret" },
        logger: log,
      });
      expect(registryIds(registry)).toEqual(["list_pets"]);
      expect(seenApiKey).toBe("spec-read-secret");
      expect(log.all()).not.toContain("spec-read-secret");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("never applies the spec-fetch timeout to the proxy writer", async () => {
    // `timeout` configures ONE thing. apcore-mcp's Rust build applies it to the
    // writer instead — the per-call proxy timeout — and never to the fetch. A
    // zero here is meaningless to an already-parsed document and would be fatal
    // to `HTTPProxyRegistryWriter`, whose constructor rejects a non-positive
    // `timeoutMs`.
    const registry = await openapiBackend(
      {
        openapi: "3.0.3",
        info: { title: "Pets", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      { timeout: 0, logger: recorder() },
    );
    expect(registryIds(registry)).toEqual(["list_pets"]);
  });

  it("runs the caller's transformModule hook before the toolkit's normalisation and the repair", async () => {
    // Normative ordering. The hook renames to a camelCase, hyphenated id and
    // clears the description. apcore-toolkit >= 0.13 normalises the final id
    // after the hook (`pet_store.list_pets`, words split), and the repair runs on
    // what `scan` returns — so the module registers, legal and described. A
    // legality check inside the hook would have skipped it; the retired
    // in-hook projection would have registered `pet_store.listpets`.
    const log = recorder();
    const registry = await openapiBackend(
      {
        openapi: "3.0.3",
        info: { title: "Pets", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      {
        logger: log,
        transformModule: (module) => ({
          ...module,
          moduleId: "Pet-Store.ListPets",
          description: "   ",
        }),
      },
    );
    expect(registryIds(registry)).toEqual(["pet_store.list_pets"]);
    expect(registry.getDefinition("pet_store.list_pets")?.description).toBe("GET /pets");
    // The INFO names the EMITTED id: a diagnostic naming the hook's raw one
    // sends the operator looking for a skill that does not exist.
    expect(log.synthesisLines()).toHaveLength(1);
    expect(log.synthesisLines()[0]).toContain("pet_store.list_pets");
    expect(log.synthesisLines()[0]).not.toContain("Pet-Store.ListPets");
    expect(log.warnings()).not.toContain("skipping OpenAPI operation");
  });

  it("drops a module the caller's hook returns null for, without a skip warning", async () => {
    const log = recorder();
    const registry = await openapiBackend(
      {
        openapi: "3.0.3",
        info: { title: "Pets", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      { logger: log, transformModule: () => null },
    );
    expect(registryIds(registry)).toEqual([]);
    expect(log.warnings()).toContain("no registrable modules");
    // A caller's deliberate drop is the caller's decision, not an illegal ID.
    expect(log.warnings()).not.toContain("skipping OpenAPI operation");
  });

  it.each([
    ["", ""],
    ["v1.2fa", "2fa"],
    ["Ab.9x", "9x"],
  ])(
    "skips an illegal hook-returned id %j, naming its segment %j",
    async (hookId, segment) => {
      // The skip applies to whatever the scanner emitted, hook output included.
      // An empty id (only a hook can produce one) names the empty segment, as
      // the toolkit's own legality warning does.
      const log = recorder();
      const registry = await openapiBackend(listPetsDocument, {
        logger: log,
        deriveModuleId: () => hookId,
      });
      expect(registryIds(registry)).toEqual([]);
      const skips = log
        .warnings()
        .split("\n")
        .filter((w) => w.includes("skipping OpenAPI operation"));
      expect(skips).toHaveLength(1);
      expect(skips[0]).toContain(`('${segment}')`);
      expect(log.errors()).toEqual([]);
    },
  );

  it("a skipped module reaches no later diagnostic", async () => {
    // An undocumented `POST /v1/2fa` is the worst case: handed to the writer
    // instead, the synthesis report would count it, FR-OAS-005 would warn about a
    // write operation that is not on the card, and the zero-modules warning —
    // the only true statement — would not fire.
    const log = recorder();
    const registry = await openapiBackend(
      {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        servers: [{ url: "https://api.example.com" }],
        paths: { "/v1/2fa": { post: { responses: { "200": { description: "ok" } } } } },
      },
      { logger: log },
    );
    expect(registryIds(registry)).toEqual([]);
    expect(log.warnings()).toContain("skipping OpenAPI operation 'v1.2fa.post'");
    expect(log.warnings()).toContain("no registrable modules");
    expect(log.warnings()).not.toContain("PUBLIC Agent Card");
    expect(log.synthesisLines()).toEqual([]);
    expect(log.errors()).toEqual([]);
    // The toolkit's own legality warning is not re-emitted beside the skip line.
    expect(log.warnings()).not.toContain("is not a legal apcore module ID");
  });

  it("never calls the deprecated projectModuleId", () => {
    // It is the identity on every id apcore-toolkit >= 0.13 emits, so a call
    // would be dead work; where it was NOT a no-op — inside transformModule,
    // before the toolkit's final normalisation — it produced a different id
    // than the toolkit (`MyThing` -> `mything`, not `my_thing`). An ESM
    // module-internal call cannot be spied on, so this reads the source.
    const source = readFileSync(new URL("../../src/openapi-backend.ts", import.meta.url), "utf8");
    const calls = source.match(/\bprojectModuleId\(/g) ?? [];
    const declarations = source.match(/function projectModuleId\(/g) ?? [];
    expect(calls.length - declarations.length).toBe(0);
  });

  // ------------------------------------------------------------------------
  // FR-OAS-006 — the preflight must not be disabled by a swallowed exception
  // ------------------------------------------------------------------------

  /** The one-operation document the preflight cases below collide against. */
  const listPetsDocument = {
    openapi: "3.0.3",
    info: { title: "Pets", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List pets",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  it("propagates a registry-read failure instead of preflighting against an empty set", async () => {
    // Reading the existing module IDs is how the preflight knows what there is
    // to collide with. Swallowing every exception and returning [] makes
    // `existing` empty, so NO collision is ever detected and the duplicate
    // arrives instead as a failed WriteResult — a skill the document
    // advertises, absent from the card, with one log line as the only notice.
    // That is the exact partial-registry failure FR-OAS-006 exists to close, so
    // a read failure must be fatal rather than silent. Python narrows its catch
    // to TypeError (the older-signature case) and Rust's `Registry::list` is
    // infallible; a catch-all here is the outlier.
    const registry = new Registry();
    registerStub(registry, "list_pets");
    (registry as unknown as { list: () => string[] }).list = () => {
      throw new Error("apcore: module store unavailable");
    };

    await expect(
      openapiBackend(listPetsDocument, { registry, logger: recorder() }),
    ).rejects.toThrow("module store unavailable");
  });

  it("still falls back for the older no-options Registry signature", async () => {
    // The narrow compatibility case the catch is actually for, kept working: a
    // TypeError from a `list` that does not accept the `visibility` option
    // falls back to the no-argument call, and the collision is still found.
    const registry = new Registry();
    registerStub(registry, "list_pets");
    const original = registry.list.bind(registry);
    (registry as unknown as { list: (options?: unknown) => string[] }).list = (
      options?: unknown,
    ) => {
      if (options !== undefined) throw new TypeError("list() takes no options");
      return original();
    };

    await expect(
      openapiBackend(listPetsDocument, { registry, logger: recorder() }),
    ).rejects.toThrow("Nothing was registered");
  });

  it("names the required segment pattern in the skip warning", async () => {
    // Canonical diagnostic text (feature spec, "Canonical diagnostic text"): the
    // drop message must carry the pattern `^[a-z][a-z0-9_]*$`. An operator told
    // only that `2fa` is a segment "apcore's registry cannot accept" has been
    // told what failed and not what would succeed — that a segment may not begin
    // with a digit is not guessable without the pattern. Rust carried the
    // fragment and Python now does; this SDK was the last one without it.
    const log = recorder();
    const registry = await openapiBackend(listPetsDocument, {
      logger: log,
      deriveModuleId: () => "v1.2fa.get",
    });
    expect(registryIds(registry)).toEqual([]);
    expect(log.warnings()).toContain("v1.2fa.get");
    expect(log.warnings()).toContain("2fa");
    expect(log.warnings()).toContain("^[a-z][a-z0-9_]*$");
  });

  it("returns null for an absent apcore-a2a.openapi section", async () => {
    expect(await buildOpenapiBackendFromConfig(null)).toBeNull();
    expect(await buildOpenapiBackendFromConfig(undefined)).toBeNull();
  });

  it("rejects an apcore-a2a.openapi section with no spec", async () => {
    await expect(buildOpenapiBackendFromConfig({ prefix: "petstore" })).rejects.toThrow(
      /spec is required/,
    );
    await expect(buildOpenapiBackendFromConfig({ spec: "   " })).rejects.toThrow(
      /spec is required/,
    );
  });

  // ------------------------------------------------------------------------
  // error_cases
  // ------------------------------------------------------------------------

  for (const c of cases("error_cases")) {
    it(c.id, async () => {
      const log = recorder();
      let registry: Registry | undefined;
      if (c.preexisting_registry_module_ids) {
        registry = new Registry();
        for (const moduleId of c.preexisting_registry_module_ids) {
          registerStub(registry, moduleId);
        }
      }

      let raised: unknown;
      try {
        await openapiBackend(c.document, { ...optionsFor(c, log), registry });
      } catch (e) {
        raised = e;
      }
      expect(raised, `${c.id}: expected a failure`).toBeDefined();

      const message = raised instanceof Error ? raised.message : String(raised);
      for (const substring of c.expected_error_substrings) {
        expect(message, `missing ${substring} in ${message}`).toContain(substring);
      }

      if (c.expected_registry_module_ids_after) {
        expect(
          registryIds(registry as Registry),
          "the preflight must leave the registry byte-for-byte unchanged",
        ).toEqual([...c.expected_registry_module_ids_after].sort());
      }
    });
  }

  // ------------------------------------------------------------------------
  // card_cases — the A2A-specific exposure, pinned as a fact
  // ------------------------------------------------------------------------

  for (const c of cases("card_cases")) {
    it(c.id, async () => {
      const log = recorder();
      const registry = await openapiBackend(c.document, optionsFor(c, log));
      const card = cardFor(registry);
      const executor = c.acl ? { _acl: new ACL(c.acl.rules, c.acl.default_effect) } : {};

      expect(skillIds(buildPublicCard(card, executor, registry as unknown as RegistryLike))).toEqual(
        [...c.expected_public_card_skills].sort(),
      );
      expect(
        skillIds(buildExtendedCard(card, executor, createIdentity("u1", "service"))),
      ).toEqual([...c.expected_extended_card_skills].sort());
    });
  }
});

// --------------------------------------------------------------------------
// the deprecated projection, and synthesis unit coverage (FR-OAS-002 / FR-OAS-003)
// --------------------------------------------------------------------------

// Deprecated — apcore-toolkit >= 0.13 emits ids in apcore's alphabet and the
// backend no longer calls it — but still exported, so its behaviour stays pinned
// until the minor release that removes it.
describe("projectModuleId (deprecated, behaviour unchanged)", () => {
  it.each([
    ["listPets", "listpets"],
    ["pet-store.items.get", "pet_store.items.get"],
    ["already.legal", "already.legal"],
    ["v1.2fa.get", null],
    ["Users.UserId.Get", "users.userid.get"],
    ["9lives", null],
    ["", null],
  ])("projects %s", (raw, expected) => {
    expect(projectModuleId(raw as string)).toBe(expected);
  });
});

describe("synthesizeDescription", () => {
  it("builds {METHOD} {path} from the writer's own metadata keys", () => {
    expect(
      synthesizeDescription({ metadata: { http_method: "delete", url_path: "/pets/{petId}" } }),
    ).toBe("DELETE /pets/{petId}");
  });

  it("degrades rather than inventing when the metadata is incomplete", () => {
    expect(synthesizeDescription({ metadata: { http_method: "get" } })).toBe("GET");
    expect(synthesizeDescription({ metadata: { url_path: "/pets" } })).toBe("/pets");
    expect(synthesizeDescription({ moduleId: "listpets", metadata: {} })).toBe("listpets");
    expect(synthesizeDescription({})).toBe("operation");
  });

  it("treats non-string metadata as absent rather than coercing it", () => {
    // `String(x ?? "")` would put `123` on the PUBLIC Agent Card as if it were
    // an HTTP method, and `false` would arrive there as the string "FALSE" —
    // a method that does not exist, published to a route A2A clients crawl. A
    // non-string here means the metadata is malformed (reachable from a
    // caller's own `transformOperation` hook or a vendor extension) and the
    // honest answer is to treat the field as absent, which is what Rust's
    // `as_str()` has always done and what Python now does.
    expect(
      synthesizeDescription({ metadata: { http_method: 123, url_path: "/pets" } }),
    ).toBe("/pets");
    expect(
      synthesizeDescription({ metadata: { http_method: false, url_path: "/pets" } }),
    ).toBe("/pets");
    expect(
      synthesizeDescription({ metadata: { http_method: "get", url_path: 7 } }),
    ).toBe("GET");
    expect(
      synthesizeDescription({
        moduleId: "listpets",
        metadata: { http_method: { verb: "GET" }, url_path: ["/pets"] },
      }),
    ).toBe("listpets");
    // The fallback chain is unchanged by the narrowing: an absent field and a
    // non-string field must reach the same rung.
    expect(
      synthesizeDescription({ moduleId: "listpets", metadata: { http_method: null } }),
    ).toBe("listpets");
  });
});
