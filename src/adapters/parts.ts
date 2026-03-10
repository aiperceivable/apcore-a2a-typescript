import type { Artifact, Part } from "@a2a-js/sdk";
import { SchemaConverter } from "./schema.js";
import type { ModuleDescriptor } from "./skill-mapper.js";

export class PartConverter {
  private schemaConverter: SchemaConverter;

  constructor(schemaConverter?: SchemaConverter) {
    this.schemaConverter = schemaConverter ?? new SchemaConverter();
  }

  partsToInput(parts: Part[], descriptor: ModuleDescriptor | null): Record<string, unknown> | string {
    if (!parts || parts.length === 0) {
      throw new Error("Message must contain at least one Part");
    }
    if (parts.length > 1) {
      throw new Error("Multiple parts are not supported; expected exactly one Part");
    }

    const part = parts[0];

    if (part.kind === "text") {
      const inputSchema = descriptor?.input_schema ?? descriptor?.inputSchema ?? null;
      const rootType = this.schemaConverter.detectRootType(inputSchema);
      if (rootType === "object") {
        try {
          return JSON.parse(part.text) as Record<string, unknown>;
        } catch (e) {
          throw new Error(`TextPart text is not valid JSON: ${e}`);
        }
      }
      return part.text;
    }

    if (part.kind === "data") {
      return part.data;
    }

    if (part.kind === "file") {
      throw new Error("FilePart is not supported");
    }

    throw new Error(`Unsupported part type: ${(part as Part).kind}`);
  }

  outputToParts(output: unknown, taskId?: string): Artifact {
    const artifactId = `art-${taskId || crypto.randomUUID()}`;

    if (output === null || output === undefined) {
      return { artifactId, parts: [] };
    }

    if (typeof output === "string") {
      return { artifactId, parts: [{ kind: "text", text: output }] };
    }

    if (Array.isArray(output)) {
      return { artifactId, parts: [{ kind: "text", text: JSON.stringify(output) }] };
    }

    if (typeof output === "object") {
      return { artifactId, parts: [{ kind: "data", data: output as Record<string, unknown> }] };
    }

    return { artifactId, parts: [{ kind: "text", text: String(output) }] };
  }
}
