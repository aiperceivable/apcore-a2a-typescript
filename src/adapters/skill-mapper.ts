import type { AgentSkill } from "@a2a-js/sdk";
import { SchemaConverter, type JsonSchema } from "./schema.js";

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

/**
 * The four behavioral annotations promoted onto the A2A wire, with the tag each
 * becomes. Order is fixed so the card is byte-identical across the three
 * bindings (srs FR-SKL-004 criterion 8).
 */
const ANNOTATION_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["readonly", "apcore:readonly"],
  ["destructive", "apcore:destructive"],
  ["idempotent", "apcore:idempotent"],
  ["requires_approval", "apcore:requires-approval"],
];

/** camelCase aliases, since a descriptor may arrive from either convention. */
const ANNOTATION_ALIASES: Readonly<Record<string, string>> = {
  requires_approval: "requiresApproval",
};

function annotationFlag(annotations: Record<string, unknown>, field: string): boolean {
  const alias = ANNOTATION_ALIASES[field];
  return Boolean(annotations[field] ?? (alias !== undefined ? annotations[alias] : undefined));
}

/**
 * Append apcore's behavioral annotations to a skill's tags (srs FR-SKL-004).
 *
 * A2A 1.0 `AgentSkill` is `{id, name, description, tags, examples, inputModes,
 * outputModes, securityRequirements}` — no `extensions`, no `metadata` — so
 * `tags` is the only carrier that exists. The `apcore:` prefix keeps these out
 * of the module's own flat tag namespace, where a user tag named `destructive`
 * would otherwise be indistinguishable from the annotation.
 *
 * Without this the Agent Card carried enough for a caller to *construct* a call
 * and not enough to judge whether making it is safe. It is also what makes retry
 * semantics usable: `retryable` is a property of the error, but whether a retry
 * is safe is a property of the operation, and a timeout is retryable for a read
 * and dangerous for a non-idempotent mutation.
 *
 * Only truthy flags are emitted, matching how the apcore MCP binding maps the
 * same annotations onto optional `readOnlyHint` / `destructiveHint` /
 * `idempotentHint`. Absence means "not asserted", never "asserted false".
 */
export function appendAnnotationTags(tags: string[], descriptor: ModuleDescriptor): void {
  const annotations = descriptor.annotations;
  if (!annotations) return;
  for (const [field, tag] of ANNOTATION_TAGS) {
    if (annotationFlag(annotations, field) && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
}

/**
 * Whether a module is gated behind human approval.
 *
 * Used by the Agent Card builder to withhold the skill from the public card
 * (srs FR-AGC-003) and restore it on the extended one (srs FR-AGC-004).
 */
export function requiresApproval(descriptor: ModuleDescriptor | null | undefined): boolean {
  const annotations = descriptor?.annotations;
  if (!annotations) return false;
  return annotationFlag(annotations, "requires_approval");
}

export class SkillMapper {
  // Share root-type detection with SchemaConverter so the "string root" rule
  // lives in exactly one place.
  constructor(private schemaConverter: SchemaConverter = new SchemaConverter()) {}

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
    appendAnnotationTags(resolvedTags, descriptor);

    return {
      id,
      name: skillName,
      description: skillDescription,
      tags: resolvedTags,
      inputModes: this.computeInputModes(descriptor),
      outputModes: this.computeOutputModes(descriptor),
      examples: this.buildExamples(descriptor),
      securityRequirements: [],
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
    if (this.schemaConverter.detectRootType(schema as JsonSchema) === "string") {
      return ["application/json", "text/plain"];
    }
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
