import { describe, it, expect, vi } from "vitest";
import { resolveRegistryAndExecutor, asyncServe } from "../src/serve.js";

function makeRegistry(modules: string[] = ["echo"]) {
  return {
    list: () => modules,
    getDefinition: (id: string) =>
      modules.includes(id)
        ? { module_id: id, description: `Module ${id}`, input_schema: { type: "object" } }
        : null,
  };
}

function makeExecutor(registry?: ReturnType<typeof makeRegistry>) {
  const reg = registry ?? makeRegistry();
  return {
    callAsync: vi.fn().mockResolvedValue({ result: "ok" }),
    registry: reg,
  };
}

describe("resolveRegistryAndExecutor", () => {
  it("resolves executor with callAsync", () => {
    const executor = makeExecutor();
    const result = resolveRegistryAndExecutor(executor);
    expect(result.executor).toBe(executor);
    expect(result.registry).toBe(executor.registry);
  });

  it("throws if executor has no .registry", () => {
    const executor = { callAsync: vi.fn() };
    expect(() => resolveRegistryAndExecutor(executor)).toThrow(TypeError);
  });

  it("resolves registry with list and getDefinition", () => {
    const registry = makeRegistry();
    const result = resolveRegistryAndExecutor(registry);
    expect(result.registry).toBe(registry);
  });

  it("throws for invalid object", () => {
    expect(() => resolveRegistryAndExecutor({})).toThrow(TypeError);
    expect(() => resolveRegistryAndExecutor("string")).toThrow(TypeError);
  });
});

describe("asyncServe", () => {
  it("returns an Express app from executor", async () => {
    const executor = makeExecutor();
    const app = await asyncServe(executor);
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe("function");
  });

  it("returns an Express app from registry with executor property", async () => {
    const registry = makeRegistry();
    // Registry with a nested executor property
    (registry as any).executor = {
      callAsync: vi.fn().mockResolvedValue({}),
    };
    const app = await asyncServe(registry);
    expect(app).toBeDefined();
  });

  it("throws ValueError for zero modules", async () => {
    const executor = makeExecutor(makeRegistry([]));
    await expect(asyncServe(executor)).rejects.toThrow("zero modules");
  });

  it("throws TypeError for invalid auth protocol", async () => {
    const executor = makeExecutor();
    await expect(
      asyncServe(executor, { auth: {} as any }),
    ).rejects.toThrow("auth missing required methods");
  });

  it("throws TypeError for invalid taskStore protocol", async () => {
    const executor = makeExecutor();
    await expect(
      asyncServe(executor, { taskStore: {} as any }),
    ).rejects.toThrow("taskStore missing required methods");
  });

  it("accepts valid auth and taskStore", async () => {
    const executor = makeExecutor();
    const auth = {
      authenticate: vi.fn().mockReturnValue(null),
      securitySchemes: vi.fn().mockReturnValue({}),
    };
    const taskStore = {
      save: vi.fn(),
      load: vi.fn(),
    };
    const app = await asyncServe(executor, { auth, taskStore });
    expect(app).toBeDefined();
  });

  it("uses metadata fallbacks", async () => {
    const registry = makeRegistry();
    (registry as any).executor = {
      callAsync: vi.fn().mockResolvedValue({}),
    };
    (registry as any).config = {
      project: { name: "my-agent", version: "2.0.0", description: "My agent" },
    };
    const app = await asyncServe(registry);
    expect(app).toBeDefined();
  });
});
