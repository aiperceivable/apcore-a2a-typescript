import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { A2AServerFactory } from "../../src/server/factory.js";
import type { Registry } from "../../src/adapters/agent-card.js";

function makeRegistry(): Registry {
  const modules: Record<string, unknown> = {
    "echo": {
      module_id: "echo",
      description: "Echo module",
      input_schema: { type: "object" },
    },
  };
  return {
    list: () => Object.keys(modules),
    getDefinition: (id: string) => (modules[id] as any) ?? null,
    register: vi.fn((id: string, desc: unknown) => {
      modules[id] = desc;
    }),
  };
}

function makeExecutor() {
  return {
    callAsync: vi.fn().mockResolvedValue({ result: "ok" }),
  };
}

const baseOpts = {
  name: "TestAgent",
  description: "A test agent",
  version: "1.0.0",
  url: "http://localhost:3000",
};

describe("A2AServerFactory", () => {
  describe("create", () => {
    it("returns Express app and AgentCard", () => {
      const factory = new A2AServerFactory();
      const { app, agentCard } = factory.create(
        makeRegistry(),
        makeExecutor(),
        baseOpts,
      );

      expect(app).toBeDefined();
      expect(agentCard.name).toBe("TestAgent");
      expect(agentCard.version).toBe("1.0.0");
      expect(agentCard.skills).toHaveLength(1);
    });
  });

  describe("health endpoint", () => {
    it("returns healthy status", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), baseOpts);

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.moduleCount).toBe(1);
      expect(res.body.version).toBe("1.0.0");
      expect(typeof res.body.uptimeSeconds).toBe("number");
    });
  });

  describe("metrics endpoint", () => {
    it("returns metrics when enabled", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), {
        ...baseOpts,
        metrics: true,
      });

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.body.activeTasks).toBe(0);
      expect(res.body.completedTasks).toBe(0);
      expect(typeof res.body.uptimeSeconds).toBe("number");
    });

    it("returns 404 when metrics disabled", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), baseOpts);

      const res = await request(app).get("/metrics");
      expect(res.status).toBe(404);
    });
  });

  describe("registerModule", () => {
    it("calls registry.register and invalidates cache", () => {
      const factory = new A2AServerFactory();
      const registry = makeRegistry();
      factory.create(registry, makeExecutor(), baseOpts);

      factory.registerModule("new-module", {
        module_id: "new-module",
        description: "New",
      });

      expect(registry.register).toHaveBeenCalledWith("new-module", {
        module_id: "new-module",
        description: "New",
      });
    });
  });
});
