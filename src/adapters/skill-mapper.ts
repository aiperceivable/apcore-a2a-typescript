import type { AgentSkill } from "@a2a-js/sdk";

export interface ModuleDescriptor {
  module_id?: string;
  moduleId?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tags?: string[];
  examples?: Array<{ title?: string }>;
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export class SkillMapper {
  toSkill(descriptor: ModuleDescriptor, moduleId?: string): AgentSkill | null {
    const description = descriptor.description;
    if (!description) return null;

    const id = descriptor.module_id ?? descriptor.moduleId ?? moduleId;
    if (!id) return null;

    // Resolve display overlay fields (§5.13)
    const display = (descriptor.metadata?.display as Record<string, unknown>) ?? {};
    const a2aDisplay = (display.a2a as Record<string, unknown>) ?? {};

    const skillName: string =
      (a2aDisplay.alias as string) ||
      (display.alias as string) ||
      this.humanizeModuleId(id);

    let skillDescription: string =
      (a2aDisplay.description as string) ||
      (display.description as string) ||
      description;

    const guidance = (a2aDisplay.guidance as string) || (display.guidance as string);
    if (guidance) {
      skillDescription = `${skillDescription}\n\nGuidance: ${guidance}`;
    }

    const resolvedTags: string[] =
      (display.tags as string[])?.length
        ? [...(display.tags as string[])]
        : [...(descriptor.tags ?? [])];

    return {
      id,
      name: skillName,
      description: skillDescription,
      tags: resolvedTags,
      inputModes: this.computeInputModes(descriptor),
      outputModes: this.computeOutputModes(descriptor),
      examples: this.buildExamples(descriptor),
    };
  }

  humanizeModuleId(moduleId: string): string {
    return moduleId
      .replace(/\./g, " ")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private computeInputModes(descriptor: ModuleDescriptor): string[] {
    const schema = descriptor.input_schema ?? descriptor.inputSchema;
    if (!schema) return ["text/plain"];
    if (schema.type === "string") return ["application/json", "text/plain"];
    return ["application/json"];
  }

  private computeOutputModes(descriptor: ModuleDescriptor): string[] {
    const schema = descriptor.output_schema ?? descriptor.outputSchema;
    if (!schema) return ["text/plain"];
    return ["application/json"];
  }

  buildExamples(descriptor: ModuleDescriptor): string[] {
    const examples = descriptor.examples ?? [];
    const result: string[] = [];
    for (const ex of examples.slice(0, 10)) {
      if (ex.title) result.push(String(ex.title));
    }
    return result;
  }
}
