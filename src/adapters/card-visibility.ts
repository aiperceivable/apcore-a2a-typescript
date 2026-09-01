import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import { Context, type Identity } from "apcore-js";
import type { ModuleDescriptor } from "./skill-mapper.js";
import { requiresApproval } from "./skill-mapper.js";

/**
 * Agent Card skill visibility — who gets to see which skills.
 *
 * apcore's ACL is the authority on who may invoke what, and the discovery
 * surface reflects that authority rather than ignoring it. Two surfaces, two
 * answers:
 *
 * - the **public** card (srs FR-AGC-003) answers "what may *anyone* call": every
 *   registered skill, minus apcore's reserved `system.*` management namespace,
 *   minus those the ACL denies to the anonymous principal, minus those gated
 *   behind a human. It resolves exactly one identity, so it is computed once when
 *   the card is built. A per-caller filter here
 *   would be strictly more accurate and unaffordable: `/.well-known/` is
 *   auth-exempt by design, so every anonymous request would drive
 *   `skills.length` calls into the consumer's ACL audit sink, each recording a
 *   `deny` decision indistinguishable from a real enforcement event, at whatever
 *   rate the client chooses.
 *
 * - the **extended** card (srs FR-AGC-004) answers "what may *you* call": the
 *   ACL resolved against the authenticated identity, with `requires_approval`
 *   skills restored — an approval gate is a prompt the caller can satisfy, not a
 *   refusal. Affordable precisely because that endpoint requires credentials.
 *
 * Only the `system.*` subtraction is unconditional. Every other one is
 * governance-shaped, and with no ACL configured they collapse: the ACL predicates
 * are empty and the `requires_approval` annotation covers only
 * `system.control.*`, leaving the six read modules to publish the deployment's
 * module inventory, health and usage to any anonymous caller. `ACL.discover()`
 * yields nothing for a missing root by design, so "no ACL at all" is the default
 * rather than an edge case — which is why the rule that has to hold there keys on
 * apcore's namespace and not on a governance verdict (srs FR-AGC-003 criteria 12
 * and 13).
 *
 * Authorization and approval are two independent results, not one (apcore
 * PROTOCOL_SPEC §6.1.6), and this module reads them apart. `ACL.check` folds
 * them into a boolean that **fails closed** on an approval requirement —
 * correct for a caller about to execute, wrong for a discovery surface, where it
 * would delete a skill from the extended card for the one reason FR-AGC-004 says
 * to keep it. `ACL.checkAccess` carries both axes, so `access` decides
 * visibility and `approvalRequired` decides only whether the public card is the
 * right surface.
 *
 * Before this module, this binding filtered nothing at all: `buildSkills`
 * iterated `registry.list()` and never consulted the ACL, so a module the ACL
 * denied to everyone was still advertised — by id, name, description and full
 * input schema — to any anonymous caller.
 *
 * **Internal module.** The `export` keywords below are module visibility, not a
 * public contract: `package.json` declares only `"."` in `exports`, so a
 * consumer cannot deep-import this file at all, and nothing here appears in
 * `docs/features/public-api.md`. The surface is expected to move —
 * `allowedSkillIds` already changed meaning once (it now reports the
 * authorization axis alone, where it used to fold in the approval gate). Depend
 * on `serve` / `A2AServerFactory` instead.
 */

/**
 * apcore's reserved namespace for the runtime's own management modules (apcore
 * PROTOCOL_SPEC §6.7) — `system.health.*`, `system.usage.*`, `system.manifest.*`
 * and, under the second opt-in, `system.control.*`. apcore identifies the
 * surface by this prefix itself, in `Executor.governanceState()`, so matching on
 * it conveys apcore's own boundary rather than inventing one.
 */
export const SYSTEM_NAMESPACE = "system.";

/** Whether `skillId` is one of apcore's management modules. */
export function isSystemSkill(skillId: string): boolean {
  return skillId.startsWith(SYSTEM_NAMESPACE);
}

/** The two axes of one ACL decision (apcore PROTOCOL_SPEC §6.8.1). */
export interface AccessDecisionLike {
  readonly access: "allow" | "deny";
  readonly approvalRequired: boolean;
}

/** The minimum surface this module reads off an apcore ACL. */
export interface AclLike {
  check(callerId: string | null, targetId: string, context?: unknown): boolean;
  checkAccess?(
    callerId: string | null,
    targetId: string,
    context?: unknown,
  ): AccessDecisionLike;
}

/** The minimum surface this module reads off an apcore Registry. */
export interface RegistryLike {
  list(): string[];
  getDefinition(moduleId: string): ModuleDescriptor | null | undefined;
}

/**
 * The apcore ACL backing `executor`, if one is configured.
 *
 * apcore-js exposes `setAcl` but no getter, so this reads the public property
 * when one appears upstream and falls back to the private field. `null` means
 * "no ACL configured", which is the common case and leaves every card
 * unfiltered.
 */
export function executorAcl(executor: unknown): AclLike | null {
  for (const key of ["acl", "_acl"] as const) {
    const acl = (executor as Record<string, unknown> | null)?.[key];
    if (acl && typeof (acl as AclLike).check === "function") {
      return acl as AclLike;
    }
  }
  return null;
}

/**
 * An apcore `Context` carrying `identity`, for conditional ACL rules.
 *
 * An ACL rule's `conditions` block (`identityTypes`, `roles`) is evaluated
 * against the context, and the check returns false without one — so a card
 * filtered with no context would hide every skill a conditional rule allows.
 * Building the context the same way the executor does is what keeps the card and
 * the call path agreeing about the same principal.
 */
function aclContext(identity: Identity | null): unknown {
  try {
    // apcore-js `Context.create` takes positional arguments (identity first),
    // unlike the Python binding's keyword form. Passing an options object here
    // would silently produce a context with no identity, and every conditional
    // rule would then evaluate false — hiding exactly the skills it allows.
    return Context.create(identity);
  } catch {
    return undefined;
  }
}

/**
 * `[authorized, approvalRequired]` for one skill, from apcore's ACL.
 *
 * Reads `checkAccess` (apcore-js >= 0.28.0, PROTOCOL_SPEC §6.8.1), which reports
 * the two axes separately. The `check` fallback exists for an ACL that predates
 * the accessor: there `approval` did not exist as a rule field, so `false` is
 * not a guess but the only value such an ACL can mean — and a boolean that
 * already fails closed degrades this surface toward showing less, never more.
 */
function decide(
  acl: AclLike,
  callerId: string | null,
  skillId: string,
  ctx: unknown,
): [boolean, boolean] {
  if (typeof acl.checkAccess !== "function") {
    return [acl.check(callerId, skillId, ctx), false];
  }
  const decision = acl.checkAccess(callerId, skillId, ctx);
  return [decision.access === "allow", decision.approvalRequired === true];
}

/**
 * The skills the ACL permits `identity` to invoke, each mapped to whether
 * invoking it needs a human first.
 *
 * With no ACL configured every id is permitted and none is gated, which is what
 * makes this free for the common single-tenant deployment.
 *
 * The ACL is consulted with **no arguments projection**, because a card is
 * discovery and there is no call site yet. An `arguments` condition (§6.1.7) is
 * therefore unevaluable, so a rule carrying one neither denies nor grants — but
 * an `allow` rule's `approval: required` stays *pending* and composes with
 * whatever grants (§6.1.1 rule 5). A skill gated only for some argument shapes
 * thus reports `true` here: at discovery time "this may need approval" is the
 * honest answer, and it is the one that keeps such a skill off the public card.
 *
 * `callerId` is left `null` deliberately. apcore defines it as the *calling
 * module* in a nested call chain, managed by `Context.child`; a top-level
 * inbound request has none, and the ACL maps `null` to `@external`. That is
 * apcore's contract, not a gap — `callers: ["@external"]` is how an operator
 * denies external access, and it has to keep matching an authenticated request
 * or the rule silently stops covering the traffic it was written for. The
 * authenticated principal travels in the context instead, where the
 * `identityTypes` / `roles` conditions see it.
 */
export function skillAccess(
  executor: unknown,
  skillIds: readonly string[],
  identity: Identity | null,
): Map<string, boolean> {
  const access = new Map<string, boolean>();
  const acl = executorAcl(executor);
  if (acl === null) {
    for (const skillId of skillIds) access.set(skillId, false);
    return access;
  }
  const base = aclContext(identity);
  for (const skillId of skillIds) {
    const ctx =
      base && typeof (base as { child?: unknown }).child === "function"
        ? (base as { child(id: string): unknown }).child(skillId)
        : undefined;
    const callerId = (ctx as { callerId?: string | null } | undefined)?.callerId ?? null;
    try {
      const [authorized, approvalRequired] = decide(acl, callerId, skillId, ctx);
      if (authorized) access.set(skillId, approvalRequired);
    } catch {
      // A broken ACL must fail closed: serving MORE than the policy allows is
      // the one outcome that cannot be walked back.
      console.warn(`ACL check raised for skill ${skillId}; withholding it`);
    }
  }
  return access;
}

/**
 * The subset of `skillIds` the ACL authorizes `identity` to invoke.
 *
 * The authorization axis alone: a skill the ACL allows but gates behind an
 * approval is in this set, because the caller may reach it. Callers that also
 * need the gate read {@link skillAccess}.
 */
export function allowedSkillIds(
  executor: unknown,
  skillIds: readonly string[],
  identity: Identity | null,
): Set<string> {
  return new Set(skillAccess(executor, skillIds, identity).keys());
}

function withSkills(card: AgentCard, keep: Set<string>): AgentCard {
  const skills = (card.skills ?? []).filter((skill: AgentSkill) => keep.has(skill.id));
  return { ...card, skills };
}

/**
 * The public card: what an unauthenticated caller could actually invoke.
 *
 * `system.*` is removed unconditionally (srs FR-AGC-003 criteria 12 and 13); the
 * remaining subtractions are governance-shaped. See the module docstring for why
 * this is resolved once rather than per caller.
 */
export function buildPublicCard(
  card: AgentCard,
  executor: unknown,
  registry: RegistryLike | null | undefined,
): AgentCard {
  // The management namespace goes first and unconditionally: it is the only
  // subtraction that survives a deployment with no ACL, and skipping the ACL for
  // these ids also keeps `system.*` out of the audit trail of a decision whose
  // answer cannot change the outcome.
  const ids = (card.skills ?? [])
    .map((skill: AgentSkill) => skill.id)
    .filter((id: string) => !isSystemSkill(id));
  const access = skillAccess(executor, ids, null);
  // Both sources of an approval gate, unioned as PROTOCOL_SPEC §6.9 composes
  // them: the module's own annotation, and an ACL rule carrying
  // `approval: required` for this principal. Since apcore 0.28.0 the annotation
  // is one source among several, so reading it alone would leave a skill on the
  // public card that an anonymous caller cannot in fact just call.
  const keep = new Set<string>();
  for (const [skillId, approvalRequired] of access) {
    if (approvalRequired) continue;
    if (registry && requiresApproval(registry.getDefinition(skillId))) continue;
    keep.add(skillId);
  }
  return withSkills(card, keep);
}

/**
 * The extended card: what the authenticated caller may invoke.
 *
 * `requires_approval` skills are kept (srs FR-AGC-004 criterion 2), whether the
 * gate comes from the module's annotation or from an ACL rule. Only the
 * authorization axis of the decision filters here — dropping a skill because it
 * needs a human would report a refusal the ACL never issued.
 *
 * `system.*` is kept too (criterion 11), filtered by the ACL like any other
 * skill: the namespace exclusion is a property of the public card, not of the
 * skill, and an authenticated management agent the ACL permits must still be
 * able to discover the surface it is entitled to drive.
 */
export function buildExtendedCard(
  card: AgentCard,
  executor: unknown,
  identity: Identity | null,
): AgentCard {
  const ids = (card.skills ?? []).map((skill: AgentSkill) => skill.id);
  return withSkills(card, allowedSkillIds(executor, ids, identity));
}
