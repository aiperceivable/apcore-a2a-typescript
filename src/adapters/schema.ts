import { deepResolveRefs } from "apcore-toolkit";

export type JsonSchema = Record<string, unknown>;

export class SchemaConverter {
  convertInputSchema(descriptor: { input_schema?: JsonSchema }): JsonSchema {
    return this.convertSchema(descriptor.input_schema);
  }

  convertOutputSchema(descriptor: { output_schema?: JsonSchema }): JsonSchema {
    return this.convertSchema(descriptor.output_schema);
  }

  detectRootType(schema: JsonSchema | null | undefined): "string" | "object" | "unknown" {
    if (!schema) return "unknown";
    if (schema.type === "string") return "string";
    if (schema.type === "object" || "properties" in schema) return "object";
    return "unknown";
  }

  private convertSchema(schema: JsonSchema | null | undefined): JsonSchema {
    let s = structuredClone(schema) as JsonSchema | null | undefined;

    if (!s || Object.keys(s).length === 0) {
      return { type: "object", properties: {} };
    }

    // Inline $refs if present. Delegate JSON $ref resolution to the shared
    // apcore-toolkit resolver (RFC 6901 pointer walk, handles $defs /
    // definitions / components, nested allOf/anyOf/oneOf/items, depth-capped
    // against circular refs) — same helper used by apcore-mcp and apcore-cli.
    // The schema itself is the resolution document because Pydantic emits
    // self-contained "#/$defs/..." pointers.
    if ("$defs" in s) {
      s = deepResolveRefs(s, s) as JsonSchema;
      delete s.$defs;
    }

    return this.ensureObjectType(s);
  }

  private ensureObjectType(schema: JsonSchema): JsonSchema {
    if (!("type" in schema)) {
      schema.type = "object";
    }
    if ("properties" in schema && schema.type !== "object") {
      schema.type = "object";
    }
    return schema;
  }
}
