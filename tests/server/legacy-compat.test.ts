/**
 * The bundled Explorer and A2AClient must be able to talk to this package's
 * own server (apexe #35 / apcore-a2a-rust ca10690).
 *
 * The Explorer and `A2AClient` speak A2A 0.3 -- `message/send`, `tasks/get`,
 * `role: "user"`, and no `A2A-Version` header. a2a-js dispatches only the A2A
 * 1.0 PascalCase method names and, per spec section 3.6.2, treats a request
 * with no version header as a 0.3 request, refusing it against a 1.0-only
 * agent card. Both halves have to be addressed: `legacyCompat` on the handlers
 * routes the 0.3 method names, and the 0.3 `supportedInterfaces` mirror is what
 * makes `validateVersion` accept a header-less request in the first place.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { A2AServerFactory } from "../../src/server/factory.js";
import type { Registry } from "../../src/adapters/agent-card.js";

function makeRegistry(): Registry {
  const modules: Record<string, unknown> = {
    echo: { module_id: "echo", description: "Echo a payload back", input_schema: { type: "object" } },
  };
  return {
    list: () => Object.keys(modules),
    getDefinition: (id: string) => (modules[id] as never) ?? null,
  };
}

function makeApp(): Express {
  const { app } = new A2AServerFactory().create(
    makeRegistry(),
    { callAsync: vi.fn().mockResolvedValue({ result: "ok" }) },
    { name: "Legacy Agent", description: "d", version: "1", url: "http://localhost" },
  );
  return app;
}

/** Byte-for-byte the body `sendMessage()` builds in src/explorer/index.html. */
function explorerSendBody(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "1",
    method: "message/send",
    params: {
      message: {
        messageId: "m1",
        role: "user",
        parts: [{ kind: "text", text: "{}" }],
        metadata: { skillId: "echo" },
      },
    },
  };
}

describe("A2A 0.3 compatibility", () => {
  it("accepts the Explorer's message/send with no A2A-Version header", async () => {
    const res = await request(makeApp()).post("/").send(explorerSendBody());

    expect(res.status).toBe(200);
    // Before legacyCompat + the 0.3 interface entry this was -32009
    // ("The requested A2A protocol version '0.3' is not supported").
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.status.state).toBe("completed");
  });

  it("accepts the A2AClient's tasks/get with no A2A-Version header", async () => {
    const app = makeApp();
    const created = await request(app).post("/").send(explorerSendBody());
    const taskId = created.body.result.id as string;

    const res = await request(app)
      .post("/")
      .send({ jsonrpc: "2.0", id: "2", method: "tasks/get", params: { id: taskId } });

    expect(res.body.error).toBeUndefined();
    expect(res.body.result.id).toBe(taskId);
  });

  it("still serves the A2A 1.0 method names", async () => {
    const res = await request(makeApp())
      .post("/")
      .set("A2A-Version", "1.0")
      .send({
        jsonrpc: "2.0",
        id: "1",
        method: "SendMessage",
        params: {
          message: {
            messageId: "m1",
            role: "ROLE_USER",
            parts: [{ text: "{}" }],
            metadata: { skillId: "echo" },
          },
        },
      });

    expect(res.body.error).toBeUndefined();
    expect(res.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("advertises both protocol versions on the same JSONRPC binding", async () => {
    const res = await request(makeApp()).get("/.well-known/agent-card.json");

    const interfaces = res.body.supportedInterfaces as {
      protocolBinding: string;
      protocolVersion: string;
      url: string;
    }[];
    // The 1.0 entry stays first and unchanged -- the shared agent_card.json
    // conformance fixture partial-matches it, and `url` stays absent at the top
    // level.
    expect(interfaces[0]).toMatchObject({ protocolBinding: "JSONRPC", protocolVersion: "1.0" });
    expect(interfaces.map((i) => i.protocolVersion)).toEqual(["1.0", "0.3"]);
    expect(res.body.url).toBeUndefined();
  });
});
