import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Part,
} from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { ApCoreAgentExecutor } from "../../src/server/executor.js";
import { PartConverter } from "../../src/adapters/parts.js";

import type { Registry } from "../../src/adapters/agent-card.js";

function makeContext(opts: {
  taskId?: string;
  contextId?: string;
  skillId?: string;
  parts?: Part[];
}) {
  return {
    taskId: opts.taskId ?? "task-1",
    contextId: opts.contextId ?? "ctx-1",
    userMessage: {
      kind: "message" as const,
      messageId: "msg-1",
      role: "user" as const,
      parts: opts.parts ?? [{ kind: "text" as const, text: '{"input":"hello"}' }],
      metadata: opts.skillId !== undefined ? { skillId: opts.skillId } : {},
    },
  };
}

function makeEventBus(): ExecutionEventBus & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    publish: vi.fn((event: unknown) => events.push(event)),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    finished: vi.fn(),
  };
}

function makeRegistry(modules: string[]): Registry {
  return {
    list: () => modules,
    getDefinition: (id: string) =>
      modules.includes(id)
        ? { module_id: id, description: `Module ${id}`, input_schema: { type: "object" } }
        : null,
  };
}

function makeExecutor(result: Record<string, unknown> = { result: "ok" }) {
  return {
    callAsync: vi.fn().mockResolvedValue(result),
  };
}

describe("ApCoreAgentExecutor", () => {
  let partConverter: PartConverter;

  beforeEach(() => {
    partConverter = new PartConverter();
  });

  describe("execute", () => {
    it("publishes artifact and completed on success", async () => {
      const executor = makeExecutor({ answer: 42 });
      const registry = makeRegistry(["my-skill"]);
      const agent = new ApCoreAgentExecutor({
        executor,
        partConverter,

        registry,
      });

      const context = makeContext({ skillId: "my-skill" });
      const bus = makeEventBus();

      await agent.execute(context as any, bus);

      // events[0] is the initial task creation event
      expect(bus.events).toHaveLength(3);
      const taskInit = bus.events[0] as any;
      expect(taskInit.kind).toBe("task");
      expect(taskInit.id).toBe("task-1");

      const artifact = bus.events[1] as TaskArtifactUpdateEvent;
      expect(artifact.kind).toBe("artifact-update");
      expect(artifact.taskId).toBe("task-1");
      expect(artifact.lastChunk).toBe(true);

      const status = bus.events[2] as TaskStatusUpdateEvent;
      expect(status.kind).toBe("status-update");
      expect(status.status.state).toBe("completed");
      expect(status.final).toBe(true);
    });

    it("publishes failed when skillId is missing", async () => {
      const agent = new ApCoreAgentExecutor({
        executor: makeExecutor(),
        partConverter,

      });

      const context = makeContext({ skillId: undefined });
      // Remove metadata.skillId
      context.userMessage.metadata = {};
      const bus = makeEventBus();

      await agent.execute(context as any, bus);

      // events[0] is the initial task event, events[1] is the failed status
      expect(bus.events).toHaveLength(2);
      const event = bus.events[1] as TaskStatusUpdateEvent;
      expect(event.status.state).toBe("failed");
      expect(event.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining("skillId") }),
      );
    });

    it("publishes failed for unknown skill", async () => {
      const registry = makeRegistry(["other-skill"]);
      const agent = new ApCoreAgentExecutor({
        executor: makeExecutor(),
        partConverter,

        registry,
      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "missing-skill" }) as any, bus);

      const event = bus.events[1] as TaskStatusUpdateEvent;
      expect(event.status.state).toBe("failed");
      expect(event.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining("Skill not found") }),
      );
    });

    it("publishes failed on execution timeout", async () => {
      const executor = {
        callAsync: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 10000)),
        ),
      };
      const agent = new ApCoreAgentExecutor({
        executor,
        partConverter,

        executionTimeout: 50,
      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "test" }) as any, bus);

      const event = bus.events[1] as TaskStatusUpdateEvent;
      expect(event.status.state).toBe("failed");
      expect(event.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining("timed out") }),
      );
    });

    it("publishes input-required for APPROVAL_PENDING error", async () => {
      const err = new Error("Approval needed");
      (err as any).code = "APPROVAL_PENDING";
      const executor = { callAsync: vi.fn().mockRejectedValue(err) };
      const agent = new ApCoreAgentExecutor({
        executor,
        partConverter,

      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "test" }) as any, bus);

      const event = bus.events[1] as TaskStatusUpdateEvent;
      expect(event.status.state).toBe("input-required");
      expect(event.final).toBe(false);
    });

    it("publishes failed for generic execution error", async () => {
      const executor = { callAsync: vi.fn().mockRejectedValue(new Error("boom")) };
      const agent = new ApCoreAgentExecutor({
        executor,
        partConverter,

      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "test" }) as any, bus);

      const event = bus.events[1] as TaskStatusUpdateEvent;
      expect(event.status.state).toBe("failed");
      expect(event.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: "Internal server error" }),
      );
    });

    it("calls onStateChange callback", async () => {
      const onStateChange = vi.fn();
      const agent = new ApCoreAgentExecutor({
        executor: makeExecutor(),
        partConverter,

        onStateChange,
      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "test" }) as any, bus);

      expect(onStateChange).toHaveBeenCalledWith("submitted", "working");
      expect(onStateChange).toHaveBeenCalledWith("working", "completed");
    });
  });

  describe("cancelTask", () => {
    it("publishes canceled status event", async () => {
      const agent = new ApCoreAgentExecutor({
        executor: makeExecutor(),
        partConverter,

      });

      const bus = makeEventBus();
      await agent.cancelTask("task-1", bus);

      expect(bus.events).toHaveLength(1);
      const event = bus.events[0] as TaskStatusUpdateEvent;
      expect(event.kind).toBe("status-update");
      expect(event.status.state).toBe("canceled");
      expect(event.final).toBe(true);
    });
  });
});
