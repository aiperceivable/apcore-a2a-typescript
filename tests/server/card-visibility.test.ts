/**
 * Agent Card skill visibility — srs FR-AGC-003 / FR-AGC-004 / FR-AGC-006.
 *
 * Covers the fixture cases in `conformance/fixtures/agent_card.json` that carry
 * `card_variant`: they need the executor's ACL, so they exercise the serve()
 * layer rather than `AgentCardBuilder.build` and the shared conformance runner
 * skips them.
 *
 * Before this behaviour existed, `buildSkills` iterated `registry.list()` and
 * consulted the ACL nowhere, so a module the ACL denied to everyone was still
 * advertised — by id, name, description and full input schema — to any anonymous
 * caller. `/.well-known/` is auth-exempt by design, so no credential stood in
 * the way.
 */
import { describe, it, expect } from "vitest";
import { ACL, createIdentity } from "apcore-js";
import type { AgentCard } from "@a2a-js/sdk";
import { AgentCardBuilder } from "../../src/adapters/agent-card.js";
import { SkillMapper } from "../../src/adapters/skill-mapper.js";
import {
  buildExtendedCard,
  buildPublicCard,
  type RegistryLike,
} from "../../src/adapters/card-visibility.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registryOf(modules: Array<Record<string, any>>): RegistryLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId: Record<string, any> = {};
  for (const m of modules) {
    byId[m.module_id] = {
      module_id: m.module_id,
      description: m.description,
      input_schema: {},
      tags: m.tags ?? [],
      annotations: m.annotations,
    };
  }
  return {
    list: () => Object.keys(byId),
    getDefinition: (id: string) => byId[id] ?? null,
  };
}

function cardOf(registry: RegistryLike): AgentCard {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AgentCardBuilder(new SkillMapper()).build(registry as any, {
    name: "agent",
    description: "d",
    version: "1.0.0",
    url: "http://localhost:8000",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    capabilities: { streaming: false, pushNotifications: false, extensions: [] } as any,
  }) as AgentCard;
}

const ids = (card: AgentCard): string[] => (card.skills ?? []).map((s) => s.id).sort();

const GATED = [
  { module_id: "math.add", description: "Adds" },
  {
    module_id: "admin.users.delete",
    description: "Deletes a user",
    annotations: { requires_approval: true, destructive: true },
  },
];

describe("Agent Card skill visibility", () => {
  it("hides requires_approval skills from the public card even without an ACL", () => {
    // srs FR-AGC-003 criterion 7. An approval gate is the operator saying "a
    // human decides each of these" — not something to advertise anonymously,
    // and withholding it is what leaves the extended card something to carry.
    const registry = registryOf(GATED);
    expect(ids(buildPublicCard(cardOf(registry), {}, registry))).toEqual(["math.add"]);
  });

  it("restores requires_approval skills on the extended card", () => {
    // srs FR-AGC-004 criterion 2 and 9: not a copy of the public card.
    const registry = registryOf(GATED);
    const card = cardOf(registry);
    const publicCard = buildPublicCard(card, {}, registry);
    const extended = buildExtendedCard(card, {}, createIdentity("u1", "service"));
    expect(ids(extended)).toEqual(["admin.users.delete", "math.add"]);
    expect(ids(publicCard)).not.toEqual(ids(extended));
  });

  it("hides skills the ACL denies to the anonymous principal", () => {
    // srs FR-AGC-003 criterion 6.
    const registry = registryOf([
      { module_id: "math.add", description: "Adds" },
      { module_id: "admin.reindex", description: "Reindexes" },
    ]);
    const acl = new ACL(
      [{ callers: ["@external"], targets: ["admin.*"], effect: "deny" }],
      "allow",
    );
    expect(ids(buildPublicCard(cardOf(registry), { _acl: acl }, registry))).toEqual(["math.add"]);
  });

  it("evaluates a conditional rule against the caller's identity", () => {
    // The card filter must build an apcore Context, or every skill a conditional
    // rule allows would be hidden: the condition check returns false without
    // one, so a context-less filter and the enforcement path would disagree
    // about the same principal.
    const registry = registryOf([{ module_id: "math.add", description: "Adds" }]);
    const acl = new ACL(
      [
        {
          callers: ["*"],
          targets: ["*"],
          effect: "allow",
          conditions: { identity_types: ["service"] },
        },
      ],
      "deny",
    );
    const card = cardOf(registry);
    const executor = { _acl: acl };
    expect(ids(buildExtendedCard(card, executor, createIdentity("u1", "service")))).toEqual([
      "math.add",
    ]);
    expect(ids(buildExtendedCard(card, executor, createIdentity("u2", "untrusted")))).toEqual([]);
    expect(ids(buildPublicCard(card, executor, registry))).toEqual([]);
  });

  it("leaves the card unfiltered when no ACL is configured", () => {
    // The common single-tenant case must cost nothing and hide nothing.
    const registry = registryOf([
      { module_id: "math.add", description: "Adds" },
      { module_id: "admin.reindex", description: "Reindexes" },
    ]);
    expect(ids(buildPublicCard(cardOf(registry), {}, registry))).toEqual([
      "admin.reindex",
      "math.add",
    ]);
  });

  it("withholds a skill when the ACL raises rather than serving it", () => {
    // A broken ACL must fail closed: serving MORE than the policy allows is the
    // one outcome that cannot be walked back.
    const registry = registryOf([{ module_id: "math.add", description: "Adds" }]);
    const brokenAcl = {
      check(): boolean {
        throw new Error("audit sink is down");
      },
    };
    expect(ids(buildPublicCard(cardOf(registry), { _acl: brokenAcl }, registry))).toEqual([]);
  });

  it("keeps an ACL-approval-gated skill off the public card and on the extended one", () => {
    // apcore 0.28.0 (PROTOCOL_SPEC §6.1.6) lets an ACL rule require a human
    // without denying the call, and §6.9 composes that with the module
    // annotation by union. A skill the operator gated that way is not something
    // an anonymous caller can just call, so it leaves the public card exactly as
    // an annotated one does — and it stays on the extended card, because the
    // caller *is* authorized: the gate is a prompt they can satisfy, not a
    // refusal.
    //
    // The regression this pins is the fold: `ACL.check` collapses the two axes
    // and returns false for allow-with-approval, so a filter written against the
    // boolean would delete the skill from BOTH cards, reporting a refusal the
    // ACL never issued.
    const registry = registryOf([
      { module_id: "math.add", description: "Adds" },
      { module_id: "vcs.push", description: "Pushes" },
    ]);
    const acl = new ACL(
      [
        { callers: ["*"], targets: ["vcs.push"], effect: "allow", approval: "required" },
        { callers: ["*"], targets: ["*"], effect: "allow" },
      ],
      "deny",
    );
    const card = cardOf(registry);
    const executor = { _acl: acl };
    expect(ids(buildPublicCard(card, executor, registry))).toEqual(["math.add"]);
    expect(ids(buildExtendedCard(card, executor, createIdentity("u1", "service")))).toEqual([
      "math.add",
      "vcs.push",
    ]);
  });

  it("still hides an ACL-denied skill from both cards", () => {
    // The approval axis must not have loosened the authorization one: a denied
    // skill is absent from the extended card too, however the decision was
    // reached.
    const registry = registryOf([{ module_id: "math.add", description: "Adds" }]);
    const acl = new ACL([{ callers: ["*"], targets: ["math.add"], effect: "deny" }], "allow");
    const card = cardOf(registry);
    const executor = { _acl: acl };
    expect(ids(buildPublicCard(card, executor, registry))).toEqual([]);
    expect(ids(buildExtendedCard(card, executor, createIdentity("u1", "service")))).toEqual([]);
  });

  // apcore's management namespace — srs FR-AGC-003 (12, 13), FR-AGC-004 (11).
  // Resolves apcore-a2a#5.
  const SYSTEM = [
    { module_id: "math.add", description: "Adds" },
    { module_id: "system.health.summary", description: "Reports health" },
    { module_id: "system.manifest.full", description: "Lists every module" },
    {
      module_id: "system.control.update_config",
      description: "Updates configuration",
      annotations: { requires_approval: true },
    },
  ];

  it("excludes the system namespace from the public card with no ACL", () => {
    // The case both ACL-shaped rules leave open. With no ACL the ACL predicates
    // are empty and the annotation covers only system.control.*, so without the
    // namespace rule the read modules would publish the deployment's module
    // inventory and health to any anonymous caller on the auth-exempt
    // /.well-known/ route.
    const registry = registryOf(SYSTEM);
    expect(ids(buildPublicCard(cardOf(registry), {}, registry))).toEqual(["math.add"]);
  });

  it("excludes the system namespace even when the ACL allows it", () => {
    // The subtraction is unconditional, not a consequence of the ACL denying
    // them: an ACL that explicitly allows everything must not put them back.
    const registry = registryOf(SYSTEM);
    const acl = new ACL([{ callers: ["*"], targets: ["*"], effect: "allow" }], "allow");
    expect(ids(buildPublicCard(cardOf(registry), { _acl: acl }, registry))).toEqual(["math.add"]);
  });

  it("keeps the system namespace on the extended card", () => {
    // srs FR-AGC-004 criterion 11. requires_approval keeps the control module
    // here too (criterion 2), so this also shows the two rules composing rather
    // than one masking the other.
    const registry = registryOf(SYSTEM);
    expect(
      ids(buildExtendedCard(cardOf(registry), {}, createIdentity("u1", "service"))),
    ).toEqual([
      "math.add",
      "system.control.update_config",
      "system.health.summary",
      "system.manifest.full",
    ]);
  });

  it("still applies the ACL to the system namespace on the extended card", () => {
    // Keeping the namespace off the public card must not exempt it from the ACL
    // on the surface where the ACL does apply.
    const registry = registryOf(SYSTEM);
    const acl = new ACL([{ callers: ["*"], targets: ["system.*"], effect: "deny" }], "allow");
    expect(
      ids(buildExtendedCard(cardOf(registry), { _acl: acl }, createIdentity("u1", "service"))),
    ).toEqual(["math.add"]);
  });
});
