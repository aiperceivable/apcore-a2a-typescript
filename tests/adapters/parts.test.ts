import { describe, it, expect } from "vitest";
import { PartConverter } from "../../src/adapters/parts.js";
import type { Part } from "@a2a-js/sdk";

describe("PartConverter", () => {
  const converter = new PartConverter();

  describe("partsToInput", () => {
    it("converts TextPart with object schema to parsed JSON", () => {
      const parts: Part[] = [{ kind: "text", text: '{"key": "value"}' }];
      const descriptor = { module_id: "test", input_schema: { type: "object", properties: {} } };
      const result = converter.partsToInput(parts, descriptor);
      expect(result).toEqual({ key: "value" });
    });

    it("converts TextPart with string schema to raw text", () => {
      const parts: Part[] = [{ kind: "text", text: "hello world" }];
      const descriptor = { module_id: "test", input_schema: { type: "string" } };
      const result = converter.partsToInput(parts, descriptor);
      expect(result).toBe("hello world");
    });

    it("converts TextPart with no schema to raw text", () => {
      const parts: Part[] = [{ kind: "text", text: "hello" }];
      const result = converter.partsToInput(parts, null);
      expect(result).toBe("hello");
    });

    it("throws on invalid JSON for object schema", () => {
      const parts: Part[] = [{ kind: "text", text: "not json" }];
      const descriptor = { module_id: "test", input_schema: { type: "object", properties: {} } };
      expect(() => converter.partsToInput(parts, descriptor)).toThrow("not valid JSON");
    });

    it("converts DataPart to its data", () => {
      const parts: Part[] = [{ kind: "data", data: { foo: "bar" } }];
      const result = converter.partsToInput(parts, null);
      expect(result).toEqual({ foo: "bar" });
    });

    it("throws on FilePart", () => {
      const parts: Part[] = [{ kind: "file", file: { uri: "http://example.com/f" } }];
      expect(() => converter.partsToInput(parts, null)).toThrow("FilePart is not supported");
    });

    it("throws on empty parts", () => {
      expect(() => converter.partsToInput([], null)).toThrow("at least one Part");
    });

    it("throws on multiple parts", () => {
      const parts: Part[] = [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
      ];
      expect(() => converter.partsToInput(parts, null)).toThrow("Multiple parts are not supported");
    });
  });

  describe("outputToParts", () => {
    it("converts null output to empty parts", () => {
      const artifact = converter.outputToParts(null, "task-1");
      expect(artifact.artifactId).toBe("art-task-1");
      expect(artifact.parts).toEqual([]);
    });

    it("converts undefined output to empty parts", () => {
      const artifact = converter.outputToParts(undefined, "task-1");
      expect(artifact.parts).toEqual([]);
    });

    it("converts string output to TextPart", () => {
      const artifact = converter.outputToParts("hello", "task-1");
      expect(artifact.parts).toHaveLength(1);
      expect(artifact.parts[0]).toEqual({ kind: "text", text: "hello" });
    });

    it("converts object output to DataPart", () => {
      const artifact = converter.outputToParts({ key: "value" }, "task-1");
      expect(artifact.parts).toHaveLength(1);
      expect(artifact.parts[0]).toEqual({ kind: "data", data: { key: "value" } });
    });

    it("converts array output to TextPart with JSON", () => {
      const artifact = converter.outputToParts([1, 2, 3], "task-1");
      expect(artifact.parts[0]).toEqual({ kind: "text", text: "[1,2,3]" });
    });

    it("converts number output to TextPart string", () => {
      const artifact = converter.outputToParts(42, "task-1");
      expect(artifact.parts[0]).toEqual({ kind: "text", text: "42" });
    });

    it("generates UUID-based artifactId when no taskId", () => {
      const artifact = converter.outputToParts("test");
      expect(artifact.artifactId).toMatch(/^art-[0-9a-f-]+$/);
    });
  });
});
