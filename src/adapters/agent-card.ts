import type { AgentCapabilities, AgentCard, AgentSkill } from "@a2a-js/sdk";
import { SkillMapper, type ModuleDescriptor } from "./skill-mapper.js";

export interface Registry {
  list(): string[];
  getDefinition(moduleId: string): ModuleDescriptor | null;
  register?(moduleId: string, descriptor: unknown): void;
}

/**
 * Convert a flat security-scheme dict (the shape `JWTAuthenticator.securitySchemes()`
 * returns, e.g. `{type:"http",scheme,bearerFormat}`) into the A2A 1.0 protobuf-JSON
 * `oneof` shape served by the reference a2a-sdk, e.g.
 * `{httpAuthSecurityScheme:{scheme,bearerFormat}}`. This keeps the served
 * `securitySchemes` byte-identical across the Python/TS/Rust SDKs (the proto3 JSON
 * mapping is the canonical A2A 1.0 wire shape; the flat OpenAPI-style form is not).
 */
function toA2ASecurityScheme(scheme: Record<string, unknown>): Record<string, unknown> {
  if (scheme.type === "http") {
    const http: Record<string, unknown> = { scheme: scheme.scheme ?? "bearer" };
    // proto3 JSON omits empty fields; only emit bearerFormat when present.
    if (scheme.bearerFormat) http.bearerFormat = scheme.bearerFormat;
    return { httpAuthSecurityScheme: http };
  }
  // Unknown scheme types map to an empty SecurityScheme (matches the Python builder).
  return {};
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

    // a2a-js 1.0 AgentCard: `url` is replaced by `supportedInterfaces`, and the
    // protocol version lives on each interface. extendedAgentCard moves to
    // capabilities.
    const card: AgentCard = {
      name: opts.name,
      description: opts.description,
      version: opts.version,
      supportedInterfaces: [
        {
          url: opts.url,
          protocolBinding: "JSONRPC",
          tenant: "",
          protocolVersion: "1.0",
        },
      ],
      provider: undefined,
      skills,
      capabilities: {
        ...opts.capabilities,
        extendedAgentCard: opts.securitySchemes != null,
      },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      securitySchemes: Object.fromEntries(
        Object.entries(opts.securitySchemes ?? {}).map(([k, v]) => [
          k,
          toA2ASecurityScheme(v as Record<string, unknown>),
        ]),
      ) as AgentCard["securitySchemes"],
      securityRequirements: [],
      signatures: [],
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
      if (!descriptor?.description?.trim()) {
        console.warn(`Skipping module ${moduleId}: missing description`);
        continue;
      }
      const skill = this.skillMapper.toSkill(descriptor, moduleId);
      if (skill) skills.push(skill);
    }
    return skills;
  }
}
