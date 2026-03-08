import type { AgentCapabilities, AgentCard, AgentSkill } from "@a2a-js/sdk";
import { SkillMapper, type ModuleDescriptor } from "./skill-mapper.js";

export interface Registry {
  list(): string[];
  getDefinition(moduleId: string): ModuleDescriptor | null;
  register?(moduleId: string, descriptor: unknown): void;
}

export class AgentCardBuilder {
  private skillMapper: SkillMapper;
  private cachedCard: AgentCard | null = null;

  constructor(skillMapper: SkillMapper) {
    this.skillMapper = skillMapper;
  }

  build(
    registry: Registry,
    opts: {
      name: string;
      description: string;
      version: string;
      url: string;
      capabilities: AgentCapabilities;
      securitySchemes?: Record<string, unknown>;
    },
  ): AgentCard {
    const skills = this.buildSkills(registry);

    const card: AgentCard = {
      name: opts.name,
      description: opts.description,
      version: opts.version,
      url: opts.url,
      protocolVersion: "0.2.1",
      skills,
      capabilities: opts.capabilities,
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      securitySchemes: opts.securitySchemes as AgentCard["securitySchemes"],
      supportsAuthenticatedExtendedCard: opts.securitySchemes != null,
    };

    this.cachedCard = card;
    return card;
  }

  getCachedOrBuild(
    registry: Registry,
    opts: {
      name: string;
      description: string;
      version: string;
      url: string;
      capabilities: AgentCapabilities;
      securitySchemes?: Record<string, unknown>;
    },
  ): AgentCard {
    if (this.cachedCard) return this.cachedCard;
    return this.build(registry, opts);
  }

  buildExtended(baseCard: AgentCard): AgentCard {
    return structuredClone(baseCard);
  }

  invalidateCache(): void {
    this.cachedCard = null;
  }

  private buildSkills(registry: Registry): AgentSkill[] {
    const skills: AgentSkill[] = [];
    for (const moduleId of registry.list()) {
      const descriptor = registry.getDefinition(moduleId);
      if (!descriptor?.description) continue;
      const skill = this.skillMapper.toSkill(descriptor, moduleId);
      if (skill) skills.push(skill);
    }
    return skills;
  }
}
