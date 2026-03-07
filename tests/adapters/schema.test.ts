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

    it("throws on circular $ref", () => {
      expect(() => {
        converter.convertInputSchema({
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
      }).toThrow("Circular $ref detected");
    });

    it("throws on unsupported $ref format", () => {
      expect(() => {
        converter.convertInputSchema({
          input_schema: {
            type: "object",
            properties: {
              a: { $ref: "http://external.com/schema" },
            },
            $defs: {},
          },
        });
      }).toThrow("Unsupported $ref format");
    });

    it("throws when $ref definition is not found", () => {
      expect(() => {
        converter.convertInputSchema({
          input_schema: {
            type: "object",
            properties: {
              a: { $ref: "#/$defs/Missing" },
            },
            $defs: {},
          },
        });
      }).toThrow("Definition not found: Missing");
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
