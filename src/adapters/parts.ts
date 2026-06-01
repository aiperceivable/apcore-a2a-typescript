import { v4 as uuidv4 } from "uuid";
import { Artifact } from "@a2a-js/sdk";
import type { Part } from "@a2a-js/sdk";
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
    // a2a-js 1.0 Part is a protobuf oneof: part.content = { $case, value }.
    const content = part.content;

    if (content?.$case === "text") {
      const text = content.value;
      const inputSchema = descriptor?.input_schema ?? descriptor?.inputSchema ?? null;
      const rootType = this.schemaConverter.detectRootType(inputSchema);
      if (rootType === "object") {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch (e) {
          throw new Error(`TextPart text is not valid JSON: ${e}`);
        }
      }
      return text;
    }

    if (content?.$case === "data") {
      return content.value as Record<string, unknown>;
    }

    if (content?.$case === "raw" || content?.$case === "url") {
      throw new Error("FilePart is not supported");
    }

    throw new Error("Unsupported part type: empty or unknown content");
  }

  outputToParts(output: unknown, taskId?: string): Artifact {
    const artifactId = `art-${taskId || uuidv4()}`;

    if (output === null || output === undefined) {
      return Artifact.fromJSON({ artifactId, parts: [] });
    }

    if (typeof output === "string") {
      return Artifact.fromJSON({ artifactId, parts: [{ text: output }] });
    }

    if (Array.isArray(output)) {
      return Artifact.fromJSON({ artifactId, parts: [{ text: JSON.stringify(output) }] });
    }

    if (typeof output === "object") {
      return Artifact.fromJSON({ artifactId, parts: [{ data: output }] });
    }

    return Artifact.fromJSON({ artifactId, parts: [{ text: String(output) }] });
  }
}
