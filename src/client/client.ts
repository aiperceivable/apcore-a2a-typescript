import { v4 as uuidv4 } from "uuid";
import { AgentCardFetcher } from "./card-fetcher.js";
import {
  A2AConnectionError,
  A2AServerError,
  TaskNotCancelableError,
  TaskNotFoundError,
} from "./exceptions.js";

/** Terminal A2A 1.0 task states; streaming stops when one is observed. */
const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/**
 * Return the event carried by a JSON-RPC SSE frame.
 *
 * Every `data:` line is a full JSON-RPC response whose `result` is the event.
 * Frames that are not enveloped pass through unchanged.
 */
/**
 * Throw if `frame` is a JSON-RPC error frame rather than an event.
 *
 * A mid-stream failure arrives as its own frame — upstream tags it
 * `event: error` and puts a JSON-RPC error response in `data:`. Envelope
 * unwrapping only looks for `result`, so without this the frame was yielded as
 * though it were an event and the failure was lost, while the non-streaming
 * path threw for a byte-identical payload. Routes through the same
 * `raiseJsonRpcError`, so a caller gets `TaskNotFoundError` /
 * `TaskNotCancelableError` on both paths.
 */
function raiseIfStreamError(frame: Record<string, unknown>): void {
  if ("jsonrpc" in frame && "error" in frame) {
    raiseJsonRpcError(frame.error as { code?: number; message?: string });
  }
}

function unwrapStreamEnvelope(frame: Record<string, unknown>): Record<string, unknown> {
  if ("jsonrpc" in frame && "result" in frame) {
    const result = frame.result;
    if (result && typeof result === "object") return result as Record<string, unknown>;
  }
  return frame;
}

/**
 * Whether `event` is a terminal `statusUpdate`.
 *
 * A2A 1.0 removed the `final` flag 0.3 used to mark the last event, so the
 * terminal state itself is the signal.
 */
function isTerminalEvent(event: Record<string, unknown>): boolean {
  const statusUpdate = event.statusUpdate as { status?: { state?: string } } | undefined;
  const state = statusUpdate?.status?.state;
  return state !== undefined && TERMINAL_STATES.has(state);
}

const JSONRPC_ERRORS: Record<number, new () => Error> = {
  [-32001]: TaskNotFoundError,
  [-32002]: TaskNotCancelableError,
};

/**
 * Message patterns that recover a typed error from a miscoded `-32603`.
 *
 * `@a2a-js/sdk` 1.0.1 bundles `toJsonRpcError` and the `A2AError` class
 * separately into `dist/server/index.js` and `dist/server/express/index.js`, so
 * an error thrown by `DefaultRequestHandler` fails both `instanceof` guards in
 * the express copy and arrives as `-32603` — with its message intact. Every
 * semantic A2A error on that path is affected (`-32001` through `-32006`);
 * these two are the ones this client maps to a type, so without this a caller's
 * `catch (e) { if (e instanceof TaskNotFoundError) ... }` silently stopped
 * matching. The message is all that is left to recover the type from.
 *
 * Deliberately *not* mirrored on the server side: rewriting the wire code would
 * mean intercepting responses and prefix-matching six message shapes, and would
 * hide the upstream bug rather than work around it. A third-party client still
 * sees `-32603`; only this one recovers.
 */
const SDK_BUNDLING_FALLBACK: ReadonlyArray<readonly [RegExp, new () => Error]> = [
  [/^Task not found(:|$)/, TaskNotFoundError],
  [/^(Task not cancelable:|Task cannot be canceled$)/, TaskNotCancelableError],
];

function raiseJsonRpcError(error: { code?: number; message?: string }): never {
  const code = error.code ?? -32603;
  const message = error.message ?? "Server error";
  const ErrorClass = JSONRPC_ERRORS[code];
  if (ErrorClass === TaskNotFoundError) throw new TaskNotFoundError();
  if (ErrorClass === TaskNotCancelableError) throw new TaskNotCancelableError();
  // Gated on -32603 so a server reporting the spec codes correctly — including
  // this package's own ErrorMapper, and any SDK build with the bundling fixed —
  // never reaches here. Once upstream is fixed the lookups above take over and
  // this loop becomes unreachable.
  if (code === -32603) {
    for (const [pattern, Fallback] of SDK_BUNDLING_FALLBACK) {
      if (pattern.test(message)) throw new Fallback();
    }
  }
  throw new A2AServerError(message, code);
}

export class A2AClient {
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private cardFetcher: AgentCardFetcher;

  constructor(url: string, opts?: { auth?: string; timeout?: number; cardTtl?: number }) {
    this.validateUrl(url);
    this.url = url.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (opts?.auth) this.headers.Authorization = opts.auth;
    this.timeout = opts?.timeout ?? 30000;
    this.cardFetcher = new AgentCardFetcher(this.url, {
      ttl: opts?.cardTtl ?? 300,
      headers: opts?.auth ? { Authorization: opts.auth } : undefined,
    });
  }

  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("bad protocol");
      }
    } catch {
      throw new TypeError(`Invalid A2A agent URL: '${url}' (must be http:// or https://)`);
    }
  }

  async discover(): Promise<Record<string, unknown>> {
    return this.cardFetcher.fetch();
  }

  /** Fetch and cache the remote Agent Card (equivalent to Python's agent_card property). */
  get agentCard(): Promise<Record<string, unknown>> {
    return this.cardFetcher.fetch();
  }

  async sendMessage(
    message: Record<string, unknown>,
    opts?: { metadata?: Record<string, unknown>; contextId?: string },
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { message, metadata: opts?.metadata ?? {} };
    if (opts?.contextId) params.contextId = opts.contextId;
    return this.jsonrpcCall("message/send", params);
  }

  async getTask(taskId: string): Promise<Record<string, unknown>> {
    return this.jsonrpcCall("tasks/get", { id: taskId });
  }

  async cancelTask(taskId: string): Promise<Record<string, unknown>> {
    return this.jsonrpcCall("tasks/cancel", { id: taskId });
  }

  /**
   * List tasks via `ListTasks`.
   *
   * A2A 1.0 names this method `ListTasks`; 0.3 had no task-listing method at
   * all. The `tasks/list` spelling used here until 0.5.0 was neither, so it
   * reached only this project's own Rust server.
   */
  async listTasks(opts?: {
    contextId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    // `limit` stays the friendly option name but goes on the wire as
    // `pageSize`, which is what `ListTasksRequest` declares (alongside
    // `pageToken`, `status`, `historyLength`, …). Sending `limit` earned an
    // -32602 from both SDK-backed servers.
    const params: Record<string, unknown> = { pageSize: opts?.limit ?? 50 };
    if (opts?.contextId) params.contextId = opts.contextId;
    return this.jsonrpcCall("ListTasks", params, "1.0");
  }

  async *streamMessage(
    message: Record<string, unknown>,
    opts?: { metadata?: Record<string, unknown>; contextId?: string },
  ): AsyncGenerator<Record<string, unknown>> {
    const params: Record<string, unknown> = { message, metadata: opts?.metadata ?? {} };
    if (opts?.contextId) params.contextId = opts.contextId;
    const body = {
      jsonrpc: "2.0",
      id: uuidv4(),
      method: "message/stream",
      params,
    };

    let response: Response;
    try {
      response = await fetch(`${this.url}/`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      throw new A2AConnectionError(String(e));
    }

    if (!response.ok || !response.body) {
      throw new A2AConnectionError(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          // Skip keepalive comments (": ...") and blank separators.
          if (line.startsWith("data:")) {
            // The try covers parsing only: a malformed frame is skipped, but a
            // JSON-RPC error frame must propagate to the caller, not be
            // swallowed by the same catch.
            let frame: Record<string, unknown>;
            try {
              frame = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
            } catch {
              continue;
            }
            raiseIfStreamError(frame);
            const event = unwrapStreamEnvelope(frame);
            const terminal = isTerminalEvent(event);
            yield event;
            if (terminal) return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  close(): void {
    // No persistent connection to close with native fetch
  }

  /**
   * POST a JSON-RPC request, optionally declaring the A2A protocol version.
   *
   * Both upstream SDKs treat a request with no `A2A-Version` header as v0.3
   * (spec section 3.6.2) and refuse 1.0 method names in that mode with
   * `-32009`, so methods that exist only in 1.0 must declare `"1.0"`. Methods
   * 0.3 also has stay unversioned, so a 0.3 server keeps working.
   */
  private async jsonrpcCall(
    method: string,
    params: Record<string, unknown>,
    a2aVersion?: string,
  ): Promise<Record<string, unknown>> {
    const body = {
      jsonrpc: "2.0",
      id: uuidv4(),
      method,
      params,
    };
    const headers = a2aVersion
      ? { ...this.headers, "A2A-Version": a2aVersion }
      : this.headers;

    let response: Response;
    try {
      response = await fetch(`${this.url}/`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      throw new A2AConnectionError(String(e));
    }

    if (!response.ok) {
      throw new A2AConnectionError(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if ("error" in data) {
      raiseJsonRpcError(data.error as { code?: number; message?: string });
    }
    return data.result as Record<string, unknown>;
  }
}
