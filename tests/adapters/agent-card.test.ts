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
  extensions: [],
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
      expect(card.supportedInterfaces[0].url).toBe("http://localhost:8000");
      expect(card.supportedInterfaces[0].protocolVersion).toBe("1.0");
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

    it("skips modules with whitespace-only description", () => {
      const registry = createRegistry({
        "has.desc": { description: "Has description" },
        "blank.desc": { description: "   " },
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

    it("takes extendedAgentCard from caller capabilities, not securitySchemes (D10-001)", () => {
      // Regression: extendedAgentCard must come from the caller's capabilities
      // (the factory sets it to `auth != null`, Python/Rust parity), NOT from
      // whether securitySchemes happen to be present. A custom authenticator can
      // configure auth while returning no security schemes.
      const registry = createRegistry({ ping: { description: "Ping" } });

      // auth configured (extended=true) but no securitySchemes → stays true.
      const cardTrue = builder.build(registry, {
        ...baseOpts,
        capabilities: { ...defaultCapabilities, extendedAgentCard: true },
      });
      expect(cardTrue.capabilities!.extendedAgentCard).toBe(true);

      // no auth (extended=false) but securitySchemes present → stays false.
      const cardFalse = builder.build(registry, {
        ...baseOpts,
        capabilities: { ...defaultCapabilities, extendedAgentCard: false },
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      });
      expect(cardFalse.capabilities!.extendedAgentCard).toBe(false);
    });

    it("emits securitySchemes in the A2A 1.0 protobuf-JSON oneof shape", () => {
      // A-D-201: the served card must use the proto3 `httpAuthSecurityScheme` oneof
      // shape (canonical 1.0, byte-identical to the Python a2a-sdk), not the flat
      // {type:"http",...} input shape that JWTAuthenticator.securitySchemes() returns.
      const registry = createRegistry({ ping: { description: "Ping" } });
      const card = builder.build(registry, {
        ...baseOpts,
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      });
      expect(card.securitySchemes).toEqual({
        bearerAuth: { httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "JWT" } },
      });
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
