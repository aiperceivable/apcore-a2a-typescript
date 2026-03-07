import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Message,
  Part,
} from "@a2a-js/sdk";
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { getAuthIdentity } from "../auth/storage.js";
import type { PartConverter } from "../adapters/parts.js";
import type { Registry } from "../adapters/agent-card.js";

function utcNow(): string {
  return new Date().toISOString();
}

function textMessage(text: string): Message {
  return {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
  };
}

export interface ApCoreAgentExecutorOptions {
  executor: {
    callAsync(
      moduleId: string,
      inputs?: Record<string, unknown> | null,
      context?: unknown,
    ): Promise<Record<string, unknown>>;
  };
  partConverter: PartConverter;
  registry?: Registry;
  executionTimeout?: number;
  onStateChange?: (oldState: string, newState: string) => void;
}

export class ApCoreAgentExecutor implements AgentExecutor {
  private executor: ApCoreAgentExecutorOptions["executor"];
  private partConverter: PartConverter;
  private registry?: Registry;
  private executionTimeout: number;
  private onStateChange?: (oldState: string, newState: string) => void;

  constructor(opts: ApCoreAgentExecutorOptions) {
    this.executor = opts.executor;
    this.partConverter = opts.partConverter;
    this.registry = opts.registry;
    this.executionTimeout = opts.executionTimeout ?? 300_000;
    this.onStateChange = opts.onStateChange;
  }

  private notify(oldState: string, newState: string): void {
    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch {
        // Callback errors must not crash the executor
      }
    }
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // 1. Get skillId from message metadata
    const metadata = context.userMessage?.metadata ?? {};
    const skillId = metadata.skillId as string | undefined;
    if (!skillId) {
      this.notify("submitted", "failed");
      this.publishFailed(context, eventBus, "Missing required parameter: metadata.skillId");
      return;
    }

    // 2. Validate skill exists in registry
    if (this.registry) {
      try {
        const known = this.registry.list();
        if (!known.includes(skillId)) {
          this.notify("submitted", "failed");
          this.publishFailed(context, eventBus, `Skill not found: ${skillId}`);
          return;
        }
      } catch {
        // Registry may be unavailable; proceed optimistically
      }
    }

    // 3. Parse Parts -> apcore input
    const parts: Part[] = context.userMessage?.parts ?? [];
    let descriptor = null;
    if (this.registry) {
      try {
        descriptor = this.registry.getDefinition(skillId);
      } catch {
        // Descriptor lookup failure is non-fatal
      }
    }

    let inputs: Record<string, unknown> | string;
    try {
      inputs = this.partConverter.partsToInput(parts, descriptor);
    } catch (e) {
      this.notify("submitted", "failed");
      this.publishFailed(context, eventBus, String(e));
      return;
    }

    // 4. Build apcore context with identity
    const identity = getAuthIdentity();
    let apcoreCtx: unknown = undefined;
    try {
      const { Context } = await import("apcore-js");
      apcoreCtx = identity ? Context.create(null, identity) : Context.create();
    } catch {
      // apcore-js Context not available in this environment
    }

    // 5. Execute via executor.callAsync() with timeout
    this.notify("submitted", "working");
    let output: Record<string, unknown>;
    try {
      const inputObj = typeof inputs === "string" ? { text: inputs } : inputs;
      const coro = apcoreCtx
        ? this.executor.callAsync(skillId, inputObj, apcoreCtx)
        : this.executor.callAsync(skillId, inputObj);
      output = await withTimeout(coro, this.executionTimeout);
    } catch (e: unknown) {
      if (e instanceof TimeoutError) {
        this.notify("working", "failed");
        this.publishFailed(context, eventBus, "Execution timed out");
        return;
      }
      const code = (e as { code?: string }).code;
      if (code === "APPROVAL_PENDING") {
        this.notify("working", "input-required");
        this.publishInputRequired(context, eventBus, String(e));
        return;
      }
      this.notify("working", "failed");
      this.publishFailed(context, eventBus, "Internal server error");
      return;
    }

    // 6. Publish artifact + completed
    const artifact = this.partConverter.outputToParts(output, context.taskId);
    const contextId = context.contextId || context.taskId;

    eventBus.publish({
      kind: "artifact-update",
      taskId: context.taskId,
      contextId,
      artifact,
      append: false,
      lastChunk: true,
    } as TaskArtifactUpdateEvent);

    eventBus.publish({
      kind: "status-update",
      taskId: context.taskId,
      contextId,
      status: { state: "completed", timestamp: utcNow() },
      final: true,
    } as TaskStatusUpdateEvent);

    this.notify("working", "completed");
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId: taskId,
      status: {
        state: "canceled",
        timestamp: utcNow(),
        message: textMessage("Canceled by client"),
      },
      final: true,
    } as TaskStatusUpdateEvent);

    this.notify("working", "canceled");
  }

  private publishFailed(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    message: string,
  ): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish({
      kind: "status-update",
      taskId: context.taskId,
      contextId,
      status: {
        state: "failed",
        timestamp: utcNow(),
        message: textMessage(message),
      },
      final: true,
    } as TaskStatusUpdateEvent);
  }

  private publishInputRequired(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    message: string,
  ): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish({
      kind: "status-update",
      taskId: context.taskId,
      contextId,
      status: {
        state: "input-required",
        timestamp: utcNow(),
        message: textMessage(message),
      },
      final: false,
    } as TaskStatusUpdateEvent);
  }
}

class TimeoutError extends Error {
  constructor() {
    super("Execution timed out");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
