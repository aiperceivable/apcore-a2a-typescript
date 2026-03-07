import type { AgentSkill } from "@a2a-js/sdk";

export interface ModuleDescriptor {
  module_id: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  tags?: string[];
  examples?: Array<{ title?: string }>;
  annotations?: Record<string, unknown>;
}

export class SkillMapper {
  toSkill(descriptor: ModuleDescriptor): AgentSkill | null {
    const description = descriptor.description;
    if (!description) return null;

    return {
      id: descriptor.module_id,
      name: this.humanizeModuleId(descriptor.module_id),
      description,
      tags: [...(descriptor.tags ?? [])],
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
    const schema = descriptor.input_schema;
    if (!schema) return ["text/plain"];
    if (schema.type === "string") return ["application/json", "text/plain"];
    return ["application/json"];
  }

  private computeOutputModes(descriptor: ModuleDescriptor): string[] {
    const schema = descriptor.output_schema;
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
