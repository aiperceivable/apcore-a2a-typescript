import { describe, it, expect } from "vitest";
import { SkillMapper, type ModuleDescriptor } from "../../src/adapters/skill-mapper.js";

describe("SkillMapper", () => {
  const mapper = new SkillMapper();

  describe("humanizeModuleId", () => {
    it("converts dots to spaces and title-cases", () => {
      expect(mapper.humanizeModuleId("image.resize")).toBe("Image Resize");
    });

    it("converts underscores to spaces and title-cases", () => {
      expect(mapper.humanizeModuleId("text_process.clean_up")).toBe("Text Process Clean Up");
    });

    it("handles single word", () => {
      expect(mapper.humanizeModuleId("ping")).toBe("Ping");
    });
  });

  describe("toSkill", () => {
    it("returns null when descriptor has no description", () => {
      const descriptor: ModuleDescriptor = { module_id: "test.module" };
      expect(mapper.toSkill(descriptor)).toBeNull();
    });

    it("returns null for empty string description", () => {
      const descriptor: ModuleDescriptor = { module_id: "test.module", description: "" };
      expect(mapper.toSkill(descriptor)).toBeNull();
    });

    it("builds AgentSkill from descriptor with description", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        tags: ["image", "resize"],
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill).not.toBeNull();
      expect(skill!.id).toBe("image.resize");
      expect(skill!.name).toBe("Image Resize");
      expect(skill!.description).toBe("Resize an image");
      expect(skill!.tags).toEqual(["image", "resize"]);
    });

    it("defaults tags to empty array", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "ping",
        description: "Ping pong",
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.tags).toEqual([]);
    });

    it("computes input modes for string schema", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "echo",
        description: "Echo text",
        input_schema: { type: "string" },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.inputModes).toEqual(["application/json", "text/plain"]);
    });

    it("computes input modes for object schema", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "process",
        description: "Process data",
        input_schema: { type: "object", properties: {} },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.inputModes).toEqual(["application/json"]);
    });

    it("defaults input modes to text/plain when no schema", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "ping",
        description: "Ping pong",
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.inputModes).toEqual(["text/plain"]);
    });

    it("computes output modes for schema present", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "process",
        description: "Process data",
        output_schema: { type: "object" },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.outputModes).toEqual(["application/json"]);
    });

    it("defaults output modes to text/plain when no schema", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "ping",
        description: "Ping pong",
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.outputModes).toEqual(["text/plain"]);
    });
  });

  describe("buildExamples", () => {
    it("extracts titles from examples", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "test",
        description: "test",
        examples: [{ title: "Example 1" }, { title: "Example 2" }],
      };
      expect(mapper.buildExamples(descriptor)).toEqual(["Example 1", "Example 2"]);
    });

    it("skips examples without title", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "test",
        description: "test",
        examples: [{ title: "Has title" }, {}, { title: "Also title" }],
      };
      expect(mapper.buildExamples(descriptor)).toEqual(["Has title", "Also title"]);
    });

    it("truncates at 10 examples", () => {
      const examples = Array.from({ length: 15 }, (_, i) => ({ title: `Ex ${i}` }));
      const descriptor: ModuleDescriptor = {
        module_id: "test",
        description: "test",
        examples,
      };
      expect(mapper.buildExamples(descriptor)).toHaveLength(10);
    });

    it("returns empty array when no examples", () => {
      const descriptor: ModuleDescriptor = { module_id: "test", description: "test" };
      expect(mapper.buildExamples(descriptor)).toEqual([]);
    });
  });
});
