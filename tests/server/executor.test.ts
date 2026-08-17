import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCodes, ModuleError } from "apcore-js";
import { Part, TaskState } from "@a2a-js/sdk";
import type { ExecutionEventBus, AgentExecutionEvent } from "@a2a-js/sdk/server";
import { ApCoreAgentExecutor } from "../../src/server/executor.js";
import { PartConverter } from "../../src/adapters/parts.js";

import type { Registry } from "../../src/adapters/agent-card.js";

/** Extract the text of a status message's first part (1.0 oneof shape). */
function statusText(data: { status?: { message?: { parts: Part[] } } }): string | undefined {
  const content = data.status?.message?.parts[0]?.content;
  return content?.$case === "text" ? content.value : undefined;
}

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
      messageId: "msg-1",
      role: "user" as const,
      parts: opts.parts ?? [Part.fromJSON({ text: '{"input":"hello"}' })],
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
      const taskInit = bus.events[0] as AgentExecutionEvent;
      expect(taskInit.kind).toBe("task");
      expect((taskInit.data as { id: string }).id).toBe("task-1");

      const artifact = bus.events[1] as AgentExecutionEvent;
      expect(artifact.kind).toBe("artifactUpdate");
      expect((artifact.data as { taskId: string }).taskId).toBe("task-1");
      expect((artifact.data as { lastChunk: boolean }).lastChunk).toBe(true);

      const status = bus.events[2] as AgentExecutionEvent;
      expect(status.kind).toBe("statusUpdate");
      expect((status.data as { status: { state: TaskState } }).status.state).toBe(
        TaskState.TASK_STATE_COMPLETED,
      );
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
      const event = (bus.events[1] as AgentExecutionEvent).data as { status: { state: TaskState } };
      expect(event.status.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(event)).toContain("skillId");
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

      const event = (bus.events[1] as AgentExecutionEvent).data as { status: { state: TaskState } };
      expect(event.status.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(event)).toContain("Skill not found");
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
        // seconds (0.05s = 50ms); fires well before the 10s mock resolves
        executionTimeout: 0.05,
      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "test" }) as any, bus);

      const event = (bus.events[1] as AgentExecutionEvent).data as { status: { state: TaskState } };
      expect(event.status.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(event)).toContain("timed out");
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

      const event = (bus.events[1] as AgentExecutionEvent).data as { status: { state: TaskState } };
      expect(event.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    });

    it("publishes failed for generic execution error", async () => {
      const executor = { callAsync: vi.fn().mockRejectedValue(new Error("boom")) };
      const agent = new ApCoreAgentExecutor({
        executor,
        partConverter,

      });

      const bus = makeEventBus();
      await agent.execute(makeContext({ skillId: "test" }) as any, bus);

      const event = (bus.events[1] as AgentExecutionEvent).data as { status: { state: TaskState } };
      expect(event.status.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(event)).toBe("Internal server error");
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
      const event = bus.events[0] as AgentExecutionEvent;
      expect(event.kind).toBe("statusUpdate");
      expect((event.data as { status: { state: TaskState } }).status.state).toBe(
        TaskState.TASK_STATE_CANCELED,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Failed-task error classification (apexe #33)
// ---------------------------------------------------------------------------

describe("failed-task error classification", () => {
  const partConverter = new PartConverter();

  /** Run one failing execution and return the FAILED status message text. */
  async function failedText(error: unknown): Promise<string | undefined> {
    const executor = { callAsync: vi.fn().mockRejectedValue(error) };
    const agent = new ApCoreAgentExecutor({ executor, partConverter });
    const bus = makeEventBus();
    await agent.execute(makeContext({ skillId: "test" }) as never, bus);
    const failed = (bus.events as AgentExecutionEvent[]).filter(
      (e) =>
        (e as { data?: { status?: { state?: TaskState } } }).data?.status?.state ===
        TaskState.TASK_STATE_FAILED,
    );
    expect(failed.length, "expected a FAILED status event").toBeGreaterThan(0);
    return statusText((failed[0] as AgentExecutionEvent).data as never);
  }

  it("lets an invalid-input error reach the caller", async () => {
    // srs FR-ERR-002/FR-ERR-006: a caller-fixable failure must carry detail.
    // Collapsing it to the generic string leaves an agent unable to tell a bad
    // argument from a crash, which is the whole point of the transport.
    const text = await failedText(
      new ModuleError(
        ErrorCodes.GENERAL_INVALID_INPUT,
        "Parameters '1' and 'l' cannot be used together",
      ),
    );
    expect(text).toContain("'1' and 'l' cannot be used together");
  });

  it("names the field on a schema-validation error", async () => {
    const text = await failedText(
      new ModuleError(ErrorCodes.SCHEMA_VALIDATION_ERROR, "width: must be integer"),
    );
    expect(text).toContain("width");
  });

  it("keeps an ACL denial masked as Task not found", async () => {
    // srs FR-ERR-003: an ACL denial must not disclose the caller, the target
    // module, or that the denial happened at all.
    const text = await failedText(
      new ModuleError(ErrorCodes.ACL_DENIED, "caller alice denied module admin.wipe"),
    );
    expect(text).toBe("Task not found");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("admin.wipe");
  });

  it("keeps the fixed message for an internal error", async () => {
    // srs FR-ERR-004 / FR-ERR-008.
    const text = await failedText(
      new ModuleError(
        ErrorCodes.GENERAL_INTERNAL_ERROR,
        "super secret internal detail leaking through",
      ),
    );
    expect(text).toBe("Internal server error");
  });

  it("appends aiGuidance for caller-fixable errors", async () => {
    // aiGuidance exists to tell an agent what to do next; the A2A caller sees
    // only this status message, so it is appended there.
    // ModuleError(code, message, details, cause, traceId, retryable, aiGuidance)
    const err = new ModuleError(
      ErrorCodes.GENERAL_INVALID_INPUT,
      "bad flag combination",
      {},
      undefined,
      undefined,
      undefined,
      "send either -1 or -l, not both",
    );
    expect(err.aiGuidance).toBe("send either -1 or -l, not both");
    const text = await failedText(err);
    expect(text).toContain("send either -1 or -l, not both");
  });

  it("withholds aiGuidance for internal errors", async () => {
    // DEPENDENCY_NOT_FOUND is the case that discriminates: apcore marks it
    // userFixable = true while the mapper sends it through the catch-all to
    // "Internal server error", so a userFixable-based gate would append the
    // guidance verbatim -- internal dependency-graph detail (module ids,
    // versions, env-var names, hostnames), none of which sanitizeMessage
    // strips.
    const err = new ModuleError(
      ErrorCodes.DEPENDENCY_NOT_FOUND,
      "boom",
      {},
      undefined,
      undefined,
      undefined,
      "module 'billing.charge' requires 'vault.secrets' >= 2.1; set VAULT_ADDR",
    );
    expect(err.userFixable, "precondition for this test").toBe(true);
    expect(await failedText(err)).toBe("Internal server error");

    const internal = new ModuleError(
      ErrorCodes.GENERAL_INTERNAL_ERROR,
      "boom",
      {},
      undefined,
      undefined,
      undefined,
      "inspect /var/log/secret.log",
    );
    expect(await failedText(internal)).toBe("Internal server error");
  });

  it("withholds aiGuidance when a module declares a masked error userFixable", async () => {
    // userFixable is author-settable, so gating on it let any module widen a
    // fixed per-class string. An ACL denial must stay exactly "Task not found"
    // (srs FR-ERR-003) whatever the module claims.
    const err = new ModuleError(
      ErrorCodes.ACL_DENIED,
      "caller alice denied admin.wipe",
      {},
      undefined,
      undefined,
      undefined,
      "ask an admin to grant you the 'admin.wipe' role",
      true,
    );
    expect(err.userFixable).toBe(true);
    expect(await failedText(err)).toBe("Task not found");
  });

  it("does not leak paths or tracebacks", async () => {
    // The redaction that the fixed string used to provide must survive the fix.
    const err = new ModuleError(
      ErrorCodes.GENERAL_INVALID_INPUT,
      'bad input at /home/deploy/app/secret.ts\nTraceback (most recent call last):\nFile "x.ts", line 42',
      {},
      undefined,
      undefined,
      undefined,
      "see /var/log/apcore/internal.log on db-prod-07",
    );
    const text = await failedText(err);
    expect(text).not.toContain("/home/deploy");
    expect(text).not.toContain("/var/log");
    expect(text).not.toContain("Traceback");
    expect(text).not.toContain("line 42");
  });
});
