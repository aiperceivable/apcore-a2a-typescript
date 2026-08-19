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
    it("sends ListTasks with the 1.0 version header and default limit", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { tasks: [] } }),
      });

      const client = new A2AClient("http://localhost:3000");
      await client.listTasks();

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      // On the wire it is `pageSize` — `ListTasksRequest` has no `limit`
      // field, and sending one earns a -32602 from both SDK-backed servers.
      expect(body.params.pageSize).toBe(50);
      expect(body.params.limit).toBeUndefined();
      // `ListTasks` is the A2A 1.0 name — 0.3 had no listing method, and the
      // `tasks/list` spelling used until 0.5.0 belonged to neither version, so
      // no upstream server routed it. Without the header the request is read as
      // v0.3 (spec 3.6.2) and the 1.0 name is refused with -32009.
      expect(body.method).toBe("ListTasks");
      expect(call[1].headers["A2A-Version"]).toBe("1.0");
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
            error: { code: -32603, message: "Internal server error" },
          }),
      });

      const client = new A2AClient("http://localhost:3000");
      await expect(client.getTask("t-1")).rejects.toThrow(A2AServerError);
    });

    /**
     * `@a2a-js/sdk` 1.0.1 bundles `toJsonRpcError` and `A2AError` into two
     * separate chunks, so every semantic A2A error thrown by
     * `DefaultRequestHandler` fails both `instanceof` guards in the express
     * copy and arrives as -32603 with its message intact. Without a message
     * fallback a caller's `instanceof TaskNotFoundError` silently stopped
     * matching. These cases go away on their own once upstream is fixed — the
     * -32001 / -32002 tests above then cover the same ground.
     */
    describe("miscoded -32603 from the SDK bundling bug", () => {
      const mockError = (message: string) => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ error: { code: -32603, message } }),
        });
        return new A2AClient("http://localhost:3000");
      };

      it.each([
        ["Task not found: t-1", TaskNotFoundError],
        ["Task not found", TaskNotFoundError],
        ["Task not cancelable: t-1", TaskNotCancelableError],
        ["Task cannot be canceled", TaskNotCancelableError],
      ])("recovers the type from %o", async (message, Expected) => {
        await expect(mockError(message).getTask("t-1")).rejects.toThrow(Expected);
      });

      it.each([
        ["Internal server error"],
        // Anchored: a message that merely mentions the phrase is not a
        // miscoded TaskNotFound, and must not be rewritten into one.
        ["Unexpected failure: Task not found in cache"],
        ["Output validation failed: Task not found"],
      ])("leaves %o as a generic server error", async (message) => {
        await expect(mockError(message).getTask("t-1")).rejects.toThrow(A2AServerError);
      });
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
    /** One A2A 1.0 SSE frame: a JSON-RPC response carrying a statusUpdate. */
    const frame = (state: string) =>
      `data: {"jsonrpc":"2.0","id":"req-1","result":{"statusUpdate":{"taskId":"t1","status":{"state":"${state}"}}}}\n`;

    async function driveStream(lines: string[]): Promise<Record<string, unknown>[]> {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(lines.join("\n")));
          controller.close();
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });

      const client = new A2AClient("http://localhost:3000");
      const events: Record<string, unknown>[] = [];
      for await (const event of client.streamMessage({ role: "user", parts: [] })) {
        events.push(event);
      }
      return events;
    }

    it("unwraps the JSON-RPC envelope and yields the event", async () => {
      const events = await driveStream([frame("TASK_STATE_WORKING")]);

      expect(events).toHaveLength(1);
      // The envelope is gone — callers get the event itself.
      expect(events[0]).not.toHaveProperty("jsonrpc");
      expect(events[0]).toEqual({
        statusUpdate: { taskId: "t1", status: { state: "TASK_STATE_WORKING" } },
      });
    });

    it("stops at a terminal status, yielding it last", async () => {
      const events = await driveStream([
        frame("TASK_STATE_SUBMITTED"),
        frame("TASK_STATE_WORKING"),
        frame("TASK_STATE_COMPLETED"),
        frame("TASK_STATE_WORKING"), // after the terminal one: must not appear
      ]);

      const states = events.map(
        (e) => (e.statusUpdate as { status: { state: string } }).status.state,
      );
      expect(states).toEqual([
        "TASK_STATE_SUBMITTED",
        "TASK_STATE_WORKING",
        "TASK_STATE_COMPLETED",
      ]);
    });

    it("ignores the removed `final` flag", async () => {
      // `final` is an A2A 0.3 construct that 1.0 dropped. The old implementation
      // keyed on it alone, so it never terminated early against a 1.0 server;
      // a stray one must not terminate early either.
      const strayFinal =
        'data: {"jsonrpc":"2.0","id":"req-1","result":{"statusUpdate":{"taskId":"t1","final":true,"status":{"state":"TASK_STATE_WORKING"}}}}\n';
      const events = await driveStream([strayFinal, frame("TASK_STATE_COMPLETED")]);

      expect(events).toHaveLength(2);
    });

    it("raises on a mid-stream error frame instead of yielding it", async () => {
      // Upstream reports a mid-stream failure as its own frame (tagged
      // `event: error`). Unwrapping only looks for `result`, so before this the
      // frame reached the caller as if it were an event and the failure was
      // lost — while the non-streaming path threw for the same payload. Mapped
      // through the same table, so this is a TaskNotFoundError.
      const errFrame =
        'data: {"jsonrpc":"2.0","id":"req-1","error":{"code":-32001,"message":"Task not found"}}\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode([frame("TASK_STATE_WORKING"), errFrame].join("\n")),
          );
          controller.close();
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });

      const client = new A2AClient("http://localhost:3000");
      const seen: Record<string, unknown>[] = [];
      await expect(
        (async () => {
          for await (const event of client.streamMessage({ role: "user", parts: [] })) {
            seen.push(event);
          }
        })(),
      ).rejects.toThrow(TaskNotFoundError);

      // Events before the error frame still reached the caller.
      expect(seen).toHaveLength(1);
    });

    it("skips keepalive comments and blank lines", async () => {
      const events = await driveStream(["", ": keepalive\n", frame("TASK_STATE_COMPLETED"), ""]);

      expect(events).toHaveLength(1);
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
