import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { A2AClient } from "../../src/client/client.js";
import {
  A2AConnectionError,
  A2AServerError,
  TaskNotFoundError,
  TaskNotCancelableError,
} from "../../src/client/exceptions.js";

describe("A2AClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("URL validation", () => {
    it("accepts http URL", () => {
      expect(() => new A2AClient("http://localhost:3000")).not.toThrow();
    });

    it("accepts https URL", () => {
      expect(() => new A2AClient("https://example.com")).not.toThrow();
    });

    it("rejects non-HTTP URL", () => {
      expect(() => new A2AClient("ftp://example.com")).toThrow(TypeError);
    });

    it("rejects invalid URL", () => {
      expect(() => new A2AClient("not-a-url")).toThrow(TypeError);
    });

    it("strips trailing slashes", () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: {} }),
      });

      const client = new A2AClient("http://localhost:3000///");
      client.getTask("test");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/",
        expect.any(Object),
      );
    });
  });

  describe("sendMessage", () => {
    it("sends JSON-RPC request with message params", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { taskId: "t-1", status: "completed" } }),
      });

      const client = new A2AClient("http://localhost:3000");
      const result = await client.sendMessage(
        { role: "user", parts: [{ kind: "text", text: "hello" }] },
        { contextId: "ctx-1" },
      );

      expect(result).toEqual({ taskId: "t-1", status: "completed" });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.method).toBe("message/send");
      expect(body.params.message.role).toBe("user");
      expect(body.params.contextId).toBe("ctx-1");
      expect(body.jsonrpc).toBe("2.0");
    });
  });

  describe("getTask", () => {
    it("sends tasks/get request", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { id: "t-1" } }),
      });

      const client = new A2AClient("http://localhost:3000");
      const result = await client.getTask("t-1");
      expect(result).toEqual({ id: "t-1" });
    });
  });

  describe("cancelTask", () => {
    it("sends tasks/cancel request", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { id: "t-1", status: "canceled" } }),
      });

      const client = new A2AClient("http://localhost:3000");
      const result = await client.cancelTask("t-1");
      expect(result).toEqual({ id: "t-1", status: "canceled" });
    });
  });

  describe("listTasks", () => {
    it("sends tasks/list with default limit", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { tasks: [] } }),
      });

      const client = new A2AClient("http://localhost:3000");
      await client.listTasks();

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.params.limit).toBe(50);
    });
  });

  describe("error handling", () => {
    it("throws A2AConnectionError on network failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const client = new A2AClient("http://localhost:3000");
      await expect(client.sendMessage({ role: "user", parts: [] })).rejects.toThrow(
        A2AConnectionError,
      );
    });

    it("throws A2AConnectionError on non-OK HTTP response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      const client = new A2AClient("http://localhost:3000");
      await expect(client.getTask("t-1")).rejects.toThrow(A2AConnectionError);
    });

    it("throws TaskNotFoundError for JSON-RPC -32001", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            error: { code: -32001, message: "Task not found" },
          }),
      });

      const client = new A2AClient("http://localhost:3000");
      await expect(client.getTask("t-1")).rejects.toThrow(TaskNotFoundError);
    });

    it("throws TaskNotCancelableError for JSON-RPC -32002", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            error: { code: -32002, message: "Not cancelable" },
          }),
      });

      const client = new A2AClient("http://localhost:3000");
      await expect(client.cancelTask("t-1")).rejects.toThrow(TaskNotCancelableError);
    });

    it("throws A2AServerError for unknown JSON-RPC error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            error: { code: -32603, message: "Internal error" },
          }),
      });

      const client = new A2AClient("http://localhost:3000");
      await expect(client.getTask("t-1")).rejects.toThrow(A2AServerError);
    });
  });

  describe("auth header", () => {
    it("includes Authorization header when auth is provided", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: {} }),
      });

      const client = new A2AClient("http://localhost:3000", { auth: "Bearer my-token" });
      await client.getTask("t-1");

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].headers.Authorization).toBe("Bearer my-token");
    });
  });

  describe("streamMessage", () => {
    it("yields SSE events from response stream", async () => {
      const sseData = [
        'data: {"kind":"status","status":"working"}\n',
        'data: {"kind":"artifact","text":"Hello"}\n',
        'data: {"kind":"status","status":"completed","final":true}\n',
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const client = new A2AClient("http://localhost:3000");
      const events: Record<string, unknown>[] = [];

      for await (const event of client.streamMessage({
        role: "user",
        parts: [{ kind: "text", text: "hi" }],
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ kind: "status", status: "working" });
      expect(events[2]).toEqual({ kind: "status", status: "completed", final: true });
    });

    it("throws A2AConnectionError on network failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const client = new A2AClient("http://localhost:3000");
      const gen = client.streamMessage({ role: "user", parts: [] });
      await expect(gen.next()).rejects.toThrow(A2AConnectionError);
    });

    it("throws A2AConnectionError when response has no body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: null,
      });

      const client = new A2AClient("http://localhost:3000");
      const gen = client.streamMessage({ role: "user", parts: [] });
      await expect(gen.next()).rejects.toThrow(A2AConnectionError);
    });
  });

  describe("close", () => {
    it("does not throw", () => {
      const client = new A2AClient("http://localhost:3000");
      expect(() => client.close()).not.toThrow();
    });
  });
});
