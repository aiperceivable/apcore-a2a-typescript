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

    it("returns null when neither descriptor.module_id nor fallback moduleId is provided", () => {
      const descriptor: ModuleDescriptor = { description: "No ID module" };
      expect(mapper.toSkill(descriptor)).toBeNull();
    });

    it("uses fallback moduleId when descriptor.module_id is missing", () => {
      const descriptor: ModuleDescriptor = { description: "Discovered module" };
      const skill = mapper.toSkill(descriptor, "text_echo");
      expect(skill).not.toBeNull();
      expect(skill!.id).toBe("text_echo");
      expect(skill!.name).toBe("Text Echo");
    });

    it("prefers descriptor.module_id over fallback moduleId", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "from.descriptor",
        description: "Has both IDs",
      };
      const skill = mapper.toSkill(descriptor, "from_fallback");
      expect(skill!.id).toBe("from.descriptor");
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

  describe("display overlay (§5.13)", () => {
    it("uses a2a alias as skill name", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { a2a: { alias: "Smart Resize" } } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.name).toBe("Smart Resize");
    });

    it("falls back to display.alias when a2a alias is absent", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { alias: "Global Alias" } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.name).toBe("Global Alias");
    });

    it("falls back to humanized module_id when no alias", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: {} },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.name).toBe("Image Resize");
    });

    it("uses a2a description", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { a2a: { description: "A2A-specific description" } } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.description).toBe("A2A-specific description");
    });

    it("falls back to display.description when a2a description is absent", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { description: "Display description" } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.description).toBe("Display description");
    });

    it("appends guidance to description", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { a2a: { guidance: "Use 1024x1024 for best results" } } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.description).toBe("Resize an image\n\nGuidance: Use 1024x1024 for best results");
    });

    it("uses display.tags over descriptor.tags", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        tags: ["original"],
        metadata: { display: { tags: ["overlay-tag-1", "overlay-tag-2"] } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.tags).toEqual(["overlay-tag-1", "overlay-tag-2"]);
    });

    it("falls back to descriptor.tags when display.tags is empty", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        tags: ["fallback"],
        metadata: { display: { tags: [] } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.tags).toEqual(["fallback"]);
    });

    it("a2a-specific override wins over global display", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: {
          display: {
            alias: "Global Alias",
            description: "Global Desc",
            a2a: { alias: "A2A Alias", description: "A2A Desc" },
          },
        },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.name).toBe("A2A Alias");
      expect(skill!.description).toBe("A2A Desc");
    });

    it("treats empty-string alias as absent (falls through)", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { a2a: { alias: "" }, alias: "" } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.name).toBe("Image Resize");
    });

    it("treats empty-string description as absent (falls through)", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { a2a: { description: "" }, description: "" } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.description).toBe("Resize an image");
    });

    it("does not append empty-string guidance", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        metadata: { display: { a2a: { guidance: "" } } },
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.description).toBe("Resize an image");
    });

    it("falls back to scanner values when no overlay present", () => {
      const descriptor: ModuleDescriptor = {
        module_id: "image.resize",
        description: "Resize an image",
        tags: ["image"],
      };
      const skill = mapper.toSkill(descriptor);
      expect(skill!.name).toBe("Image Resize");
      expect(skill!.description).toBe("Resize an image");
      expect(skill!.tags).toEqual(["image"]);
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
