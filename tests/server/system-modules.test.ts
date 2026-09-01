/**
 * apcore's `system.*` management namespace — srs FR-AGC-003 (12, 13), FR-AGC-004
 * (11), FR-AGC-007. Resolves `aiperceivable/apcore-a2a` issue #5.
 *
 * Two defects, deliberately fixed together. `sysModules: true` registered
 * nothing — the factory built the registration `Config` as
 * `{apcore: {sys_modules: ...}}` while apcore reads `sys_modules.enabled` in
 * legacy mode, so `registerSysModules` returned at its first line. And had that
 * config path been repaired on its own, the six read modules would have started
 * publishing the deployment's module inventory, health and usage to any
 * anonymous caller, because `/.well-known/` is auth-exempt and a deployment
 * without an `acl/` directory has no ACL at all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Registry, Executor, Config, registerSysModules, module as apcoreModule } from "apcore-js";
import { Type } from "@sinclair/typebox";
import { A2AServerFactory } from "../../src/server/factory.js";

const baseOpts = {
  name: "agent",
  description: "d",
  version: "1.0.0",
  url: "http://localhost:8000",
};

function registryWithAUserModule(): Registry {
  const registry = new Registry();
  apcoreModule({
    id: "math.add",
    description: "Adds two numbers",
    inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
    outputSchema: Type.Object({ sum: Type.Number() }),
    execute: (inputs) => ({ sum: (inputs.a as number) + (inputs.b as number) }),
    registry,
  });
  return registry;
}

const systemIds = (registry: Registry): string[] =>
  registry
    .list()
    .filter((id: string) => id.startsWith("system."))
    .sort();

const create = (registry: Registry, executor: unknown, opts: Record<string, unknown> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new A2AServerFactory().create(registry as any, executor as any, { ...baseOpts, ...opts } as any);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apcore system.* modules", () => {
  it("actually registers them when sysModules is true", () => {
    // The bug this pins: the flag was a silent no-op in every deployment.
    const registry = registryWithAUserModule();
    create(registry, new Executor({ registry }), { sysModules: true });
    const ids = systemIds(registry);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("system.health.summary");
    expect(ids).toContain("system.manifest.full");
  });

  it("registers nothing when sysModules is false", () => {
    const registry = registryWithAUserModule();
    create(registry, new Executor({ registry }), { sysModules: false });
    expect(systemIds(registry)).toEqual([]);
  });

  it("keeps registered system modules off the public card", () => {
    // srs FR-AGC-003 criteria 12 and 13, end to end and with no ACL configured —
    // which is the state of every deployment without an acl/ directory.
    const registry = registryWithAUserModule();
    const { agentCard } = create(registry, new Executor({ registry }), { sysModules: true });
    expect(systemIds(registry).length).toBeGreaterThan(0);
    expect((agentCard.skills ?? []).map((s) => s.id)).toEqual(["math.add"]);
  });

  it("warns when the control surface is unprotected", () => {
    // srs FR-AGC-007 criterion 2, reached the way a real deployment reaches it:
    // the operator builds their own apcore stack with sys_modules.events enabled
    // — which is what registers the three system.control.* write modules — and
    // hands the Executor to this package. apcore's approval gate warns once and
    // continues with no ApprovalHandler, so those modules stay callable even
    // though FR-AGC-003 criterion 12 keeps them off the card.
    const registry = registryWithAUserModule();
    const executor = new Executor({ registry });
    registerSysModules(
      registry,
      executor,
      new Config({ sys_modules: { enabled: true, events: { enabled: true } } }),
    );
    expect(executor.governanceState().unprotectedControlSurface).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agentCard } = create(registry, executor);
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("system.control");
    expect(said).toContain("remain callable");
    // The warning is a diagnostic and changes nothing.
    expect((agentCard.skills ?? []).map((s) => s.id)).toEqual(["math.add"]);
  });

  it("stays quiet when only the read modules are registered", () => {
    // srs FR-AGC-007 criterion 3.
    const registry = registryWithAUserModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    create(registry, new Executor({ registry }), { sysModules: true });
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("system.control");
  });

  it("tolerates an executor that does not expose the accessor", () => {
    // srs FR-AGC-007 criterion 5: the reaction is a diagnostic, not a dependency.
    const registry = registryWithAUserModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => create(registry, { callAsync: async () => ({}) })).not.toThrow();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("system.control");
  });
});
