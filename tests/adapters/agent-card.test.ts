import { describe, it, expect } from "vitest";
import { AgentCardBuilder, type Registry } from "../../src/adapters/agent-card.js";
import { SkillMapper } from "../../src/adapters/skill-mapper.js";
import type { AgentCapabilities } from "@a2a-js/sdk";

function createRegistry(modules: Record<string, { description?: string }>): Registry {
  return {
    list: () => Object.keys(modules),
    getDefinition: (id: string) => {
      const m = modules[id];
      return m ? { module_id: id, description: m.description } : null;
    },
  };
}

const defaultCapabilities: AgentCapabilities = {
  streaming: true,
  pushNotifications: false,
  stateTransitionHistory: true,
};

describe("AgentCardBuilder", () => {
  const mapper = new SkillMapper();
  const builder = new AgentCardBuilder(mapper);

  const baseOpts = {
    name: "test-agent",
    description: "A test agent",
    version: "1.0.0",
    url: "http://localhost:8000",
    capabilities: defaultCapabilities,
  };

  describe("build", () => {
    it("creates card with skills from registry", () => {
      const registry = createRegistry({
        "image.resize": { description: "Resize images" },
        "text.summarize": { description: "Summarize text" },
      });

      const card = builder.build(registry, baseOpts);

      expect(card.name).toBe("test-agent");
      expect(card.description).toBe("A test agent");
      expect(card.version).toBe("1.0.0");
      expect(card.url).toBe("http://localhost:8000");
      expect(card.skills).toHaveLength(2);
      expect(card.skills![0].id).toBe("image.resize");
      expect(card.skills![1].id).toBe("text.summarize");
    });

    it("skips modules without description", () => {
      const registry = createRegistry({
        "has.desc": { description: "Has description" },
        "no.desc": {},
      });

      const card = builder.build(registry, baseOpts);
      expect(card.skills).toHaveLength(1);
      expect(card.skills![0].id).toBe("has.desc");
    });

    it("sets default input/output modes", () => {
      const registry = createRegistry({ ping: { description: "Ping" } });
      const card = builder.build(registry, baseOpts);
      expect(card.defaultInputModes).toEqual(["text/plain", "application/json"]);
      expect(card.defaultOutputModes).toEqual(["text/plain", "application/json"]);
    });

    it("sets supportsAuthenticatedExtendedCard when securitySchemes provided", () => {
      const registry = createRegistry({ ping: { description: "Ping" } });
      const card = builder.build(registry, {
        ...baseOpts,
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      });
      expect(card.supportsAuthenticatedExtendedCard).toBe(true);
    });

    it("sets supportsAuthenticatedExtendedCard to false without securitySchemes", () => {
      const registry = createRegistry({ ping: { description: "Ping" } });
      const card = builder.build(registry, baseOpts);
      expect(card.supportsAuthenticatedExtendedCard).toBe(false);
    });
  });

  describe("caching", () => {
    it("getCachedOrBuild returns cached card", () => {
      const freshBuilder = new AgentCardBuilder(mapper);
      const registry = createRegistry({ ping: { description: "Ping" } });

      const card1 = freshBuilder.build(registry, baseOpts);
      const card2 = freshBuilder.getCachedOrBuild(registry, baseOpts);
      expect(card1).toBe(card2);
    });

    it("getCachedOrBuild builds when no cache", () => {
      const freshBuilder = new AgentCardBuilder(mapper);
      const registry = createRegistry({ ping: { description: "Ping" } });

      const card = freshBuilder.getCachedOrBuild(registry, baseOpts);
      expect(card.name).toBe("test-agent");
    });

    it("invalidateCache clears cached card", () => {
      const freshBuilder = new AgentCardBuilder(mapper);
      const registry = createRegistry({ ping: { description: "Ping" } });

      const card1 = freshBuilder.build(registry, baseOpts);
      freshBuilder.invalidateCache();
      const card2 = freshBuilder.getCachedOrBuild(registry, baseOpts);
      expect(card1).not.toBe(card2);
    });
  });

  describe("buildExtended", () => {
    it("returns a deep copy of the base card", () => {
      const registry = createRegistry({ ping: { description: "Ping" } });
      const card = builder.build(registry, baseOpts);
      const extended = builder.buildExtended(card);

      expect(extended).toEqual(card);
      expect(extended).not.toBe(card);
      expect(extended.skills).not.toBe(card.skills);
    });
  });
});
