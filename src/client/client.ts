import { v4 as uuidv4 } from "uuid";
import { AgentCardFetcher } from "./card-fetcher.js";
import {
  A2AConnectionError,
  A2AServerError,
  TaskNotCancelableError,
  TaskNotFoundError,
} from "./exceptions.js";

const JSONRPC_ERRORS: Record<number, new () => Error> = {
  [-32001]: TaskNotFoundError,
  [-32002]: TaskNotCancelableError,
};

function raiseJsonRpcError(error: { code?: number; message?: string }): never {
  const code = error.code ?? -32603;
  const message = error.message ?? "Server error";
  const ErrorClass = JSONRPC_ERRORS[code];
  if (ErrorClass === TaskNotFoundError) throw new TaskNotFoundError();
  if (ErrorClass === TaskNotCancelableError) throw new TaskNotCancelableError();
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

  async listTasks(opts?: {
    contextId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { limit: opts?.limit ?? 50 };
    if (opts?.contextId) params.contextId = opts.contextId;
    return this.jsonrpcCall("tasks/list", params);
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
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
              yield data;
              const final =
                data.final ||
                (data.result as Record<string, unknown> | undefined)?.final;
              if (final) return;
            } catch {
              continue;
            }
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

  private async jsonrpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = {
      jsonrpc: "2.0",
      id: uuidv4(),
      method,
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
