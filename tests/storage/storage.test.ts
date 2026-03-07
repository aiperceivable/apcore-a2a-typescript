import { describe, it, expect } from "vitest";
import { InMemoryTaskStore } from "../../src/storage/index.js";

describe("Storage", () => {
  describe("InMemoryTaskStore", () => {
    it("can be imported from storage module", () => {
      expect(InMemoryTaskStore).toBeDefined();
    });

    it("save and load round-trip", async () => {
      const store = new InMemoryTaskStore();
      const task = {
        kind: "task" as const,
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "submitted" as const, timestamp: new Date().toISOString() },
      };

      await store.save(task);
      const loaded = await store.load("task-1");
      expect(loaded).toEqual(task);
    });

    it("returns undefined for unknown task", async () => {
      const store = new InMemoryTaskStore();
      const result = await store.load("nonexistent");
      expect(result).toBeUndefined();
    });
  });
});
