export type JsonSchema = Record<string, unknown>;

const MAX_REF_DEPTH = 32;

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

    if ("$defs" in s) {
      const defs = s.$defs as Record<string, JsonSchema>;
      s = this.inlineRefs(s, defs, new Set(), 0) as JsonSchema;
      delete s.$defs;
    }

    return this.ensureObjectType(s);
  }

  private inlineRefs(
    schema: unknown,
    defs: Record<string, JsonSchema>,
    seen: Set<string>,
    depth: number,
  ): unknown {
    if (depth > MAX_REF_DEPTH) {
      throw new Error(`Schema $ref depth limit exceeded (max ${MAX_REF_DEPTH})`);
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.inlineRefs(item, defs, seen, depth + 1));
    }

    if (schema !== null && typeof schema === "object") {
      const obj = schema as Record<string, unknown>;

      if ("$ref" in obj && typeof obj.$ref === "string") {
        const refPath = obj.$ref;
        if (seen.has(refPath)) {
          throw new Error(`Circular $ref detected: ${refPath}`);
        }
        const resolved = this.resolveRef(refPath, defs);
        return this.inlineRefs(resolved, defs, new Set([...seen, refPath]), depth + 1);
      }

      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === "$defs") continue;
        result[key] = this.inlineRefs(value, defs, seen, depth + 1);
      }
      return result;
    }

    return schema;
  }

  private resolveRef(refPath: string, defs: Record<string, JsonSchema>): JsonSchema {
    if (!refPath.startsWith("#/$defs/")) {
      throw new Error(`Unsupported $ref format: ${refPath}`);
    }
    const defName = refPath.slice(8);
    if (!(defName in defs)) {
      throw new Error(`Definition not found: ${defName}`);
    }
    return structuredClone(defs[defName]);
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
