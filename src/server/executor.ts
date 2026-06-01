import { v4 as uuidv4 } from "uuid";
import { Artifact, Part, Role, TaskState } from "@a2a-js/sdk";
import type { Message, TaskStatus } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { getAuthIdentity } from "../auth/storage.js";
import type { PartConverter } from "../adapters/parts.js";
import type { Registry } from "../adapters/agent-card.js";

function utcNow(): string {
  return new Date().toISOString();
}

function textMessage(text: string): Message {
  return {
    messageId: uuidv4(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_AGENT,
    parts: [Part.fromJSON({ text })],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Build a TaskStatus with the current timestamp (a2a-js 1.0 protobuf shape). */
function makeStatus(state: TaskState, message?: Message): TaskStatus {
  return { state, message, timestamp: utcNow() };
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
  // P0-B: CancelToken map keyed by taskId
  private cancelTokens = new Map<string, { cancel(): void }>();

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
    // 1. Initialize task in the event bus so ResultManager can track it
    const contextId = context.contextId || context.taskId;
    eventBus.publish(
      AgentEvent.task({
        id: context.taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: undefined,
      }),
    );

    // 2. Get skillId from message metadata
    const metadata = context.userMessage?.metadata ?? {};
    const skillId = metadata.skillId as string | undefined;
    if (!skillId) {
      this.notify("submitted", "failed");
      this.publishFailed(context, eventBus, "Missing required parameter: metadata.skillId");
      return;
    }

    // 3. Validate skill exists in registry
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

    // 4. Parse Parts -> apcore input
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

    // 5. Build apcore context with identity and CancelToken (P0-B)
    const identity = getAuthIdentity();
    let apcoreCtx: unknown = undefined;
    try {
      const { Context, CancelToken, CTX_GLOBAL_DEADLINE } = await import("apcore-js");
      // P0-B: create a CancelToken per task and store it
      const token = new CancelToken();
      this.cancelTokens.set(context.taskId, token);
      // Map the A2A executionTimeout onto apcore's global_deadline so apcore
      // can stop cooperatively between streaming chunks / pipeline steps.
      // NOTE: apcore-js enforces the deadline from data[CTX_GLOBAL_DEADLINE]
      // (ms-since-epoch), NOT the Context.create globalDeadline param — so we
      // seed it via data. Pre-seeding also wins over BuiltinContextCreation,
      // which only sets the key when absent.
      const data = { [CTX_GLOBAL_DEADLINE]: Date.now() + this.executionTimeout };
      // Context.create(identity, traceParent, cancelToken, data, services, globalDeadline)
      apcoreCtx = identity
        ? Context.create(identity, null, token, data)
        : Context.create(null, null, token, data);
    } catch {
      // apcore-js Context/CancelToken not available in this environment
    }

    // 6. Check if executor supports streaming (P0-A)
    const streamFn = (this.executor as { stream?: unknown }).stream;
    const canStream =
      typeof streamFn === "function" &&
      (streamFn.constructor?.name === "AsyncGeneratorFunction" ||
        Object.prototype.toString.call(streamFn) === "[object AsyncGeneratorFunction]");

    // 7. Execute with timeout
    this.notify("submitted", "working");
    const inputObj = typeof inputs === "string" ? { text: inputs } : inputs;

    try {
      if (canStream) {
        // P0-A: Streaming path
        await withTimeout(
          this.executeStreaming(context, eventBus, skillId, inputObj, apcoreCtx),
          this.executionTimeout,
        );
      } else {
        // Non-streaming path (callAsync)
        let output: Record<string, unknown>;
        const coro = apcoreCtx
          ? this.executor.callAsync(skillId, inputObj, apcoreCtx)
          : this.executor.callAsync(skillId, inputObj);
        output = await withTimeout(coro, this.executionTimeout);

        // 8. Publish artifact + completed
        const artifact = this.partConverter.outputToParts(output, context.taskId);

        eventBus.publish(
          AgentEvent.artifactUpdate({
            taskId: context.taskId,
            contextId,
            artifact,
            append: false,
            lastChunk: true,
            metadata: undefined,
          }),
        );

        this.publishCompleted(context, eventBus);
      }
    } catch (e: unknown) {
      // Clean up cancel token on any exit
      this.cancelTokens.delete(context.taskId);

      if (e instanceof TimeoutError) {
        this.notify("working", "failed");
        this.publishFailed(context, eventBus, "Execution timed out");
        return;
      }
      const code = (e as { code?: string }).code;
      if (code === "MODULE_TIMEOUT") {
        // apcore enforced global_deadline (streaming or cooperative step)
        this.notify("working", "failed");
        this.publishFailed(context, eventBus, "Execution timed out");
        return;
      }
      if (code === "EXECUTION_CANCELLED") {
        this.notify("working", "canceled");
        this.publishCanceled(context, eventBus, "Execution cancelled");
        return;
      }
      if (code === "APPROVAL_PENDING") {
        this.notify("working", "input-required");
        this.publishInputRequired(context, eventBus, String(e));
        return;
      }
      console.error(`Execution failed for task ${context.taskId} skill ${skillId}:`, e);
      this.notify("working", "failed");
      this.publishFailed(context, eventBus, "Internal server error");
      return;
    }

    // Clean up cancel token on successful completion
    this.cancelTokens.delete(context.taskId);
  }

  /**
   * P0-A: Streaming execution path. Iterates executor.stream() and emits
   * TaskArtifactUpdateEvent for each chunk, then publishes completed.
   */
  private async executeStreaming(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    moduleId: string,
    inputs: Record<string, unknown>,
    apcoreCtx: unknown,
  ): Promise<void> {
    const contextId = context.contextId || context.taskId;
    const artifactId = `art-${context.taskId}`;
    let chunkIndex = 0;

    const streamFn = (
      this.executor as unknown as {
        stream: (moduleId: string, inputs: Record<string, unknown>, ctx?: unknown) => AsyncGenerator<Record<string, unknown>>;
      }
    ).stream;
    const gen = apcoreCtx
      ? streamFn.call(this.executor, moduleId, inputs, apcoreCtx)
      : streamFn.call(this.executor, moduleId, inputs);

    for await (const chunk of gen) {
      const artifact = this.partConverter.outputToParts(chunk, context.taskId);
      // Override artifactId to be consistent across chunks
      const chunkArtifact: Artifact = { ...artifact, artifactId };

      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId: context.taskId,
          contextId,
          artifact: chunkArtifact,
          append: chunkIndex > 0,
          lastChunk: false,
          metadata: undefined,
        }),
      );

      chunkIndex++;
    }

    // Signal end of stream with lastChunk: true
    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId: context.taskId,
        contextId,
        artifact: Artifact.fromJSON({ artifactId, parts: [] }),
        append: chunkIndex > 0,
        lastChunk: true,
        metadata: undefined,
      }),
    );

    this.publishCompleted(context, eventBus);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    // P0-B: Cancel the running execution via CancelToken
    const token = this.cancelTokens.get(taskId);
    if (token) {
      token.cancel();
      this.cancelTokens.delete(taskId);
    }

    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: taskId,
        status: makeStatus(TaskState.TASK_STATE_CANCELED, textMessage("Canceled by client")),
        metadata: undefined,
      }),
    );

    this.notify("working", "canceled");
  }

  private publishCompleted(context: RequestContext, eventBus: ExecutionEventBus): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      }),
    );

    this.notify("working", "completed");
  }

  private publishFailed(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    message: string,
  ): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_FAILED, textMessage(message)),
        metadata: undefined,
      }),
    );
  }

  private publishInputRequired(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    message: string,
  ): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_INPUT_REQUIRED, textMessage(message)),
        metadata: undefined,
      }),
    );
  }

  private publishCanceled(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    message: string,
  ): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_CANCELED, textMessage(message)),
        metadata: undefined,
      }),
    );
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
