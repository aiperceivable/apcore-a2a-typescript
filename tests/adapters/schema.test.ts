import { describe, it, expect } from "vitest";
import { SchemaConverter } from "../../src/adapters/schema.js";

describe("SchemaConverter", () => {
  const converter = new SchemaConverter();

  describe("convertInputSchema", () => {
    it("returns default object schema for null input_schema", () => {
      const result = converter.convertInputSchema({ input_schema: undefined });
      expect(result).toEqual({ type: "object", properties: {} });
    });

    it("returns default object schema for empty input_schema", () => {
      const result = converter.convertInputSchema({ input_schema: {} });
      expect(result).toEqual({ type: "object", properties: {} });
    });

    it("preserves existing schema and ensures type object", () => {
      const result = converter.convertInputSchema({
        input_schema: { properties: { name: { type: "string" } } },
      });
      expect(result.type).toBe("object");
      expect(result.properties).toEqual({ name: { type: "string" } });
    });

    it("does not mutate original schema", () => {
      const original = { type: "object", properties: { x: { type: "number" } } };
      const copy = structuredClone(original);
      converter.convertInputSchema({ input_schema: original });
      expect(original).toEqual(copy);
    });
  });

  describe("$ref inlining", () => {
    it("inlines $ref and removes $defs", () => {
      const result = converter.convertInputSchema({
        input_schema: {
          type: "object",
          properties: {
            step: { $ref: "#/$defs/Step" },
          },
          $defs: {
            Step: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      });
      expect(result.$defs).toBeUndefined();
      expect((result.properties as Record<string, unknown>).step).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
      });
    });

    it("handles nested $refs", () => {
      const result = converter.convertInputSchema({
        input_schema: {
          type: "object",
          properties: {
            item: { $ref: "#/$defs/Item" },
          },
          $defs: {
            Item: {
              type: "object",
              properties: {
                tag: { $ref: "#/$defs/Tag" },
              },
            },
            Tag: { type: "string" },
          },
        },
      });
      const item = (result.properties as Record<string, Record<string, unknown>>).item;
      expect((item.properties as Record<string, unknown>).tag).toEqual({ type: "string" });
    });

    it("handles circular $ref gracefully (depth-capped, no throw)", () => {
      // apcore-toolkit's resolver is depth-capped and does not throw on
      // circular refs — it returns a partially-resolved schema. Matches the
      // shared behavior used by apcore-mcp / apcore-cli and the Python adapter.
      let result: Record<string, unknown> | undefined;
      expect(() => {
        result = converter.convertInputSchema({
          input_schema: {
            type: "object",
            properties: {
              a: { $ref: "#/$defs/A" },
            },
            $defs: {
              A: { type: "object", properties: { b: { $ref: "#/$defs/A" } } },
            },
          },
        });
      }).not.toThrow();
      expect(result!.$defs).toBeUndefined();
      expect((result!.properties as Record<string, unknown>).a).toBeDefined();
    });

    it("resolves an unsupported (non-pointer) $ref to an empty object", () => {
      const result = converter.convertInputSchema({
        input_schema: {
          type: "object",
          properties: {
            a: { $ref: "http://external.com/schema" },
          },
          $defs: {},
        },
      });
      expect((result.properties as Record<string, unknown>).a).toEqual({});
    });

    it("resolves a missing $ref definition to an empty object", () => {
      const result = converter.convertInputSchema({
        input_schema: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/Missing" },
          },
          $defs: {},
        },
      });
      expect((result.properties as Record<string, unknown>).a).toEqual({});
    });
  });

  describe("detectRootType", () => {
    it('returns "string" for string schema', () => {
      expect(converter.detectRootType({ type: "string" })).toBe("string");
    });

    it('returns "object" for object schema', () => {
      expect(converter.detectRootType({ type: "object" })).toBe("object");
    });

    it('returns "object" for schema with properties', () => {
      expect(converter.detectRootType({ properties: {} })).toBe("object");
    });

    it('returns "unknown" for null schema', () => {
      expect(converter.detectRootType(null)).toBe("unknown");
    });

    it('returns "unknown" for undefined schema', () => {
      expect(converter.detectRootType(undefined)).toBe("unknown");
    });

    it('returns "unknown" for array schema', () => {
      expect(converter.detectRootType({ type: "array" })).toBe("unknown");
    });
  });

  describe("convertOutputSchema", () => {
    it("converts output schema same as input", () => {
      const result = converter.convertOutputSchema({ output_schema: { type: "string" } });
      expect(result.type).toBe("string");
    });
  });
});
