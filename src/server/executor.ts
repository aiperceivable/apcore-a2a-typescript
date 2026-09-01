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
import {
  ErrorMapper,
  carriesCallerDetail,
  isGovernanceRefusal,
  sanitizeMessage,
} from "../adapters/errors.js";
import type { PartConverter } from "../adapters/parts.js";
import type { Registry } from "../adapters/agent-card.js";

/**
 * This package's default error-redaction policy, used when no deployment has
 * opted into disclosing governance refusal reasons (srs FR-ERR-011). The
 * executor swaps in its own instance when the flag is set.
 */
const errorMapper = new ErrorMapper();

/**
 * Caller-facing text for a FAILED task status.
 *
 * Delegates to {@link ErrorMapper} so the task-status surface classifies exactly
 * like the JSON-RPC surface instead of collapsing every code to one string:
 *
 * - internal / unrecognized errors keep the fixed `"Internal server error"`
 *   (srs FR-ERR-004 / FR-ERR-008, locked by the shared `error_mapping.json` and
 *   `streaming_events.json` fixtures);
 * - governance refusals carry a fixed per-class string — `"Access denied"`,
 *   `"Approval denied"`, `"Approval timed out"` (srs FR-ERR-003 / FR-ERR-009 /
 *   FR-ERR-010) — naming no caller, target, approver or rule;
 * - caller-fixable classes (schema validation, invalid input, unknown module)
 *   carry their sanitized detail, which srs FR-ERR-002 requires precisely so a
 *   caller "can correct their input without guessing".
 *
 * For those detail-carrying classes the error's `aiGuidance` is appended when
 * apcore supplied one: it exists to tell an agent what to do next, and an A2A
 * caller sees only this status message. It is withheld for every other class,
 * where the message is a fixed per-class string that must stay fixed.
 *
 * The gate is {@link carriesCallerDetail} -- the same partition `ErrorMapper`
 * itself branches on. Gating on `error.userFixable` instead would be a different
 * partition: six apcore codes are `userFixable === true` yet fall into the
 * mapper's catch-all, so e.g. a `DEPENDENCY_NOT_FOUND` failure would send the
 * caller `"Internal server error (module 'x' requires 'y' >= 2.1; ...)"` -- the
 * deliberately-opaque string extended with dependency-graph detail that
 * {@link sanitizeMessage} does not strip (it removes only paths and
 * traceback-shaped lines, not module ids, versions, env-var names or
 * hostnames). `userFixable` is settable per-error by the module author, so any
 * module could widen the fixed string further.
 */
function failureText(error: unknown, mapper: ErrorMapper = errorMapper): string {
  const message = mapper.toJsonRpcError(error).message;
  const guidance = (error as { aiGuidance?: unknown } | null)?.aiGuidance;
  if (
    carriesCallerDetail(error, mapper.discloseRefusalReason) &&
    typeof guidance === "string" &&
    guidance.trim() !== ""
  ) {
    return `${message} (${sanitizeMessage(guidance)})`;
  }
  return message;
}

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
  /**
   * Forward apcore's own reason for a governance refusal instead of the fixed
   * per-class string (srs FR-ERR-011). Off by default.
   */
  discloseRefusalReason?: boolean;
}

export class ApCoreAgentExecutor implements AgentExecutor {
  private executor: ApCoreAgentExecutorOptions["executor"];
  private partConverter: PartConverter;
  private registry?: Registry;
  // Public executionTimeout is in seconds (matches the Python binding); stored
  // here in milliseconds for setTimeout / global_deadline arithmetic.
  private executionTimeoutMs: number;
  private onStateChange?: (oldState: string, newState: string) => void;
  // P0-B: CancelToken map keyed by taskId
  private cancelTokens = new Map<string, { cancel(): void }>();
  private errorMapper: ErrorMapper;

  constructor(opts: ApCoreAgentExecutorOptions) {
    this.executor = opts.executor;
    this.partConverter = opts.partConverter;
    this.registry = opts.registry;
    this.executionTimeoutMs = (opts.executionTimeout ?? 300) * 1000;
    this.onStateChange = opts.onStateChange;
    this.errorMapper = opts.discloseRefusalReason
      ? new ErrorMapper(true)
      : errorMapper;
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

    // 3. Validate skill exists in registry. Spec: "Validate skill_id is a known
    // module -> error -32601 if not". Fail CLOSED: if the registry lookup throws
    // or the skill is not found, publish a failed task (matches Python/Rust).
    if (this.registry) {
      let known: string[];
      try {
        known = this.registry.list();
      } catch {
        // Registry unavailable: cannot confirm the skill, so fail closed rather
        // than proceeding optimistically.
        this.notify("submitted", "failed");
        this.publishFailed(context, eventBus, `Skill not found: ${skillId}`);
        return;
      }
      if (!known.includes(skillId)) {
        this.notify("submitted", "failed");
        this.publishFailed(context, eventBus, `Skill not found: ${skillId}`);
        return;
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
      const data = { [CTX_GLOBAL_DEADLINE]: Date.now() + this.executionTimeoutMs };
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
        // P0-A: Streaming path. The timeout is enforced cooperatively by
        // apcore's global_deadline (seeded above) between chunks/steps and
        // surfaces as MODULE_TIMEOUT, so we do NOT wrap the stream in a second
        // withTimeout (matches the Python binding, which relies on
        // global_deadline rather than asyncio.wait_for on the streaming path).
        await this.executeStreaming(context, eventBus, skillId, inputObj, apcoreCtx);
      } else {
        // Non-streaming path (callAsync)
        let output: Record<string, unknown>;
        const coro = apcoreCtx
          ? this.executor.callAsync(skillId, inputObj, apcoreCtx)
          : this.executor.callAsync(skillId, inputObj);
        output = await withTimeout(coro, this.executionTimeoutMs);

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
        // A resumable pause, not a refusal: the message carries the approvalId
        // the caller resumes with (srs FR-EXE-002). Must not be swept in with
        // the governance codes below — `rejected` is terminal, so re-coding it
        // would end the conversation.
        this.notify("working", "input-required");
        this.publishInputRequired(context, eventBus, String(e));
        return;
      }
      if (isGovernanceRefusal(code)) {
        // A2A 1.0 defines `rejected` as terminal, and a policy refusal is what
        // it describes (srs FR-ERR-012). `failed` said only "something broke",
        // which for a refusal is both wrong and an invitation to retry. This is
        // the surface that matters on message/send, where the response is a
        // JSON-RPC `result` and the error code never reaches the caller at all.
        this.notify("working", "rejected");
        this.publishRejected(context, eventBus, failureText(e, this.errorMapper));
        return;
      }
      console.error(`Execution failed for task ${context.taskId} skill ${skillId}:`, e);
      this.notify("working", "failed");
      this.publishFailed(context, eventBus, failureText(e, this.errorMapper));
      return;
    } finally {
      // Clean up the cancel token on every exit path (matches Python's
      // finally / Rust's Drop guard).
      this.cancelTokens.delete(context.taskId);
    }
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

    // A-D-13: bound the entire streaming loop by a host-side wall-clock budget.
    // apcore's cooperative global_deadline only stops well-behaved modules
    // between chunks; this Promise.race guarantees the loop terminates even if
    // the generator stalls (matches Rust's stream_channel tokio timeout). The
    // deadline spans the whole stream, not just a single chunk.
    const deadline = Date.now() + this.executionTimeoutMs;
    const iterator = gen[Symbol.asyncIterator]();
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await iterator.return?.(undefined);
        throw new TimeoutError();
      }
      let next: IteratorResult<Record<string, unknown>>;
      try {
        next = await withTimeout(iterator.next(), remaining);
      } catch (e) {
        if (e instanceof TimeoutError) {
          // Signal the underlying generator to stop iterating.
          await iterator.return?.(undefined);
        }
        throw e;
      }
      if (next.done) break;
      const chunk = next.value;

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

  /** Emit REJECTED status for a governance refusal (srs FR-ERR-012). */
  private publishRejected(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    message: string,
  ): void {
    const contextId = context.contextId || context.taskId;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_REJECTED, textMessage(message)),
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
