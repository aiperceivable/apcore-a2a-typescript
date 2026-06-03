/** Conformance — Algorithm A-CARD: Agent Card builder-level wire-shape parity. */
import { describe, it, expect } from "vitest";
import { AgentCardBuilder } from "../../src/adapters/agent-card.js";
import { SkillMapper } from "../../src/adapters/skill-mapper.js";
import { loadFixture, partialMatch } from "./_spec.js";

const fixture = loadFixture("agent_card.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registryFor(modules: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId: Record<string, any> = {};
  for (const m of modules) byId[m.module_id] = { module_id: m.module_id, description: m.description, input_schema: {} };
  return {
    list: () => Object.keys(byId),
    getDefinition: (id: string) => byId[id] ?? null,
  };
}

(fixture ? describe : describe.skip)("A-CARD: agent card", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.test_cases ?? []) {
    it(c.id, () => {
      const spec = c.input;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const card = new AgentCardBuilder(new SkillMapper()).build(registryFor(spec.modules) as any, {
        name: spec.name,
        description: spec.description,
        version: spec.version,
        url: spec.url,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capabilities: { streaming: false, pushNotifications: false, extensions: [] } as any,
        securitySchemes: spec.security_schemes_input,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      if (c.expected_card) {
        const err = partialMatch(c.expected_card, card);
        expect(err, `${c.id}: ${err}`).toBeNull();
      }
      for (const absent of c.expected_card_absent_keys ?? []) expect(absent in card, `${c.id}: ${absent}`).toBe(false);
      if (c.expected_skill_count != null) expect((card.skills ?? []).length).toBe(c.expected_skill_count);
      if (c.expected_security_requirements_empty) expect((card.securityRequirements ?? []).length).toBe(0);
      if (c.expected_security_schemes_empty) expect(Object.keys(card.securitySchemes ?? {}).length).toBe(0);
    });
  }
});
