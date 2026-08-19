/**
 * Task-addressed methods are scoped to the authenticated principal (apexe #34).
 *
 * a2a-js scopes task storage by an owner resolved from the ServerCallContext
 * (`resolveUserScope` -> `context.user?.userName`), and DefaultRequestHandler
 * loads the task from that context-scoped store before every task-addressed
 * method. The handlers were mounted with `UserBuilder.noAuthentication`, so
 * every request carried an UnauthenticatedUser and every caller shared one
 * owner bucket: `ListTasks` returned every caller's tasks including their full
 * stdout, and any principal holding another's task id could read it, cancel it,
 * or redirect its terminal statusUpdate to a webhook of its choosing.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Server } from "node:http";
import { createIdentity } from "apcore-js";
import { A2AServerFactory } from "../../src/server/factory.js";
import type { Registry } from "../../src/adapters/agent-card.js";
import type { Authenticator } from "../../src/auth/types.js";

const ALICE = "alice";
const BOB = "bob";
const UNKNOWN_TASK_ID = "00000000-0000-0000-0000-000000000000";

/**
 * JSON-RPC code a2a-js currently reports for `TaskNotFoundError` on the express
 * path. The spec code is -32001, and `@a2a-js/sdk@1.0.0-alpha.0` emitted it;
 * 1.0.1 bundles `toJsonRpcError` and the `A2AError` class separately into
 * `dist/server/index.js` and `dist/server/express/index.js`, so the error
 * thrown by `DefaultRequestHandler` fails both `instanceof` guards in the
 * express copy and falls through to INTERNAL_ERROR. It affects every semantic
 * A2A error on this path, not just this one, and the message is unaffected —
 * so the masking property below still holds. Pinned rather than asserted as
 * -32001 so a future SDK fix shows up as a failing test here.
 */
const TASK_NOT_FOUND_CODE = -32603;

function makeRegistry(): Registry {
  const modules: Record<string, unknown> = {
    echo: { module_id: "echo", description: "Echo a payload back", input_schema: { type: "object" } },
  };
  return {
    list: () => Object.keys(modules),
    getDefinition: (id: string) => (modules[id] as never) ?? null,
  };
}

/** Authenticator whose bearer token *is* the principal id. */
const bearerIsPrincipal: Authenticator = {
  authenticate: (headers) => {
    const token = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
    return token ? createIdentity(token) : null;
  },
  securitySchemes: () => ({ bearerAuth: { type: "http", scheme: "bearer" } }),
};

function makeApp(auth?: Authenticator): Express {
  const { app } = new A2AServerFactory().create(
    makeRegistry(),
    { callAsync: vi.fn().mockResolvedValue({ result: "ok" }) },
    {
      name: "Scoping Agent",
      description: "d",
      version: "1",
      url: "http://localhost",
      auth,
      pushNotifications: true,
    },
  );
  return app;
}

/**
 * One listening server per app, reused by every request.
 *
 * `request(app)` starts — and tears down — a throwaway server per call. Doing
 * that dozens of times in quick succession made roughly 1 request in 120 miss
 * the app's middleware chain entirely and come back `404 Cannot POST /`, which
 * surfaced as an intermittent failure of the cross-principal assertions below:
 * an attacker request that should have been refused instead produced an empty
 * body, so `error?.code` read as `undefined`. Measured: ~1/120 failures when
 * each request built its own server, 0 in 600 when the server was reused.
 * Nothing in the server code was involved — the requests never reached it.
 */
const servers = new WeakMap<Express, Promise<Server>>();
const openServers: Server[] = [];

function serverFor(app: Express): Promise<Server> {
  let pending = servers.get(app);
  if (!pending) {
    // Awaiting `listening` matters: `listen()` binds asynchronously, and
    // handing supertest a socket that is not up yet reintroduces the very race
    // this helper exists to remove.
    pending = new Promise<Server>((resolve, reject) => {
      const server = app.listen(0);
      openServers.push(server);
      server.once("listening", () => resolve(server));
      server.once("error", reject);
    });
    servers.set(app, pending);
  }
  return pending;
}

afterAll(() => {
  for (const server of openServers) server.close();
});

type RpcResponse = { result?: Record<string, unknown>; error?: { code: number; message: string } };

async function rpc(
  app: Express,
  who: string,
  method: string,
  params: unknown,
): Promise<RpcResponse> {
  const res = await request(await serverFor(app))
    .post("/")
    .set("Authorization", `Bearer ${who}`)
    // a2a-js treats a request with no A2A-Version header as v0.3 (spec section
    // 3.6.2) and this server speaks 1.0 only, so the header is mandatory here.
    .set("A2A-Version", "1.0")
    .send({ jsonrpc: "2.0", id: "1", method, params });
  return res.body as RpcResponse;
}

/** Run one task as `who` and return its id. */
async function submit(app: Express, who: string, messageId: string): Promise<string> {
  const body = await rpc(app, who, "SendMessage", {
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ text: "{}" }],
      metadata: { skillId: "echo" },
    },
  });
  expect(body.error, JSON.stringify(body)).toBeUndefined();
  return (body.result as { task: { id: string } }).task.id;
}

async function listTaskIds(app: Express, who: string): Promise<string[]> {
  // An explicit status is required: a2a-js decodes an absent `status` as the
  // proto default TASK_STATE_UNSPECIFIED (0) and then filters on it, so an
  // unfiltered ListTasks returns nothing. That is upstream behaviour and
  // orthogonal to scoping.
  const body = await rpc(app, who, "ListTasks", { status: "TASK_STATE_COMPLETED" });
  expect(body.error, JSON.stringify(body)).toBeUndefined();
  const tasks = (body.result as { tasks?: { id: string }[] }).tasks ?? [];
  return tasks.map((t) => t.id).sort();
}

describe("task scoping", () => {
  describe("reads", () => {
    it("hides another principal's task behind the same response as an unknown id", async () => {
      const app = makeApp(bearerIsPrincipal);
      const aliceTask = await submit(app, ALICE, "m-alice");

      const own = await rpc(app, ALICE, "GetTask", { id: aliceTask });
      expect((own.result as { id: string }).id).toBe(aliceTask);

      const denied = (await rpc(app, BOB, "GetTask", { id: aliceTask })).error;
      const unknown = (await rpc(app, BOB, "GetTask", { id: UNKNOWN_TASK_ID })).error;
      // Masked as "not found", not "forbidden" (srs FR-ERR-003): a caller must
      // not learn that another principal's task id exists. Both responses are a
      // pure function of the id the caller itself supplied, so task ids cannot
      // be probed.
      expect(denied?.code).toBe(TASK_NOT_FOUND_CODE);
      expect(unknown?.code).toBe(TASK_NOT_FOUND_CODE);
      expect(denied?.message).toBe(`Task not found: ${aliceTask}`);
      expect(unknown?.message).toBe(`Task not found: ${UNKNOWN_TASK_ID}`);
    });

    it("lists only the caller's own tasks", async () => {
      const app = makeApp(bearerIsPrincipal);
      const aliceOne = await submit(app, ALICE, "m-a1");
      const aliceTwo = await submit(app, ALICE, "m-a2");
      const bobTask = await submit(app, BOB, "m-b1");

      const aliceIds = await listTaskIds(app, ALICE);
      const bobIds = await listTaskIds(app, BOB);

      expect(aliceIds).toEqual([aliceOne, aliceTwo].sort());
      expect(bobIds).toEqual([bobTask]);
      // The defect this closes: bob could read the full stdout of alice's tasks.
      expect(aliceIds).not.toContain(bobTask);
    });

    it("scopes cancel to the owner", async () => {
      const app = makeApp(bearerIsPrincipal);
      const aliceTask = await submit(app, ALICE, "m-alice");

      const denied = (await rpc(app, BOB, "CancelTask", { id: aliceTask })).error;
      expect(denied?.code).toBe(TASK_NOT_FOUND_CODE);
      expect(denied?.message).toBe(`Task not found: ${aliceTask}`);
    });
  });

  describe("push notification configs", () => {
    it("scopes set to the owner", async () => {
      // The worst of the six: a redirect of somebody else's terminal statusUpdate.
      const app = makeApp(bearerIsPrincipal);
      const aliceTask = await submit(app, ALICE, "m-alice");

      const owner = await rpc(app, ALICE, "CreateTaskPushNotificationConfig", {
        taskId: aliceTask,
        pushNotificationConfig: { url: "https://alice.example/hook" },
      });
      expect(owner.error, JSON.stringify(owner)).toBeUndefined();

      const attacker = await rpc(app, BOB, "CreateTaskPushNotificationConfig", {
        taskId: aliceTask,
        pushNotificationConfig: { url: "https://attacker.example/hook" },
      });
      expect(attacker.error?.code).toBe(TASK_NOT_FOUND_CODE);
    });

    it("scopes get and delete to the owner", async () => {
      const app = makeApp(bearerIsPrincipal);
      const aliceTask = await submit(app, ALICE, "m-alice");
      const created = await rpc(app, ALICE, "CreateTaskPushNotificationConfig", {
        taskId: aliceTask,
        pushNotificationConfig: { url: "https://alice.example/hook" },
      });
      expect(created.error, JSON.stringify(created)).toBeUndefined();
      const configId = (created.result as { id: string }).id;
      const params = { taskId: aliceTask, id: configId };

      expect((await rpc(app, ALICE, "GetTaskPushNotificationConfig", params)).error).toBeUndefined();
      expect((await rpc(app, BOB, "GetTaskPushNotificationConfig", params)).error?.code).toBe(
        TASK_NOT_FOUND_CODE,
      );
      // Deleting the owner's config would silently suppress their notifications.
      expect((await rpc(app, BOB, "DeleteTaskPushNotificationConfig", params)).error?.code).toBe(
        TASK_NOT_FOUND_CODE,
      );
      // The owner's config survived the attempt.
      expect((await rpc(app, ALICE, "GetTaskPushNotificationConfig", params)).error).toBeUndefined();
    });

    it("scopes list to the owner", async () => {
      const app = makeApp(bearerIsPrincipal);
      const aliceTask = await submit(app, ALICE, "m-alice");

      expect(
        (await rpc(app, BOB, "ListTaskPushNotificationConfigs", { taskId: aliceTask })).error?.code,
      ).toBe(TASK_NOT_FOUND_CODE);
    });
  });

  describe("degradation without an authenticator", () => {
    it("puts every caller in one owner bucket", async () => {
      // Documented degradation, matching a2a-js's own UnauthenticatedUser:
      // resolveUserScope falls back to a single bucket when userName is empty.
      // A single-tenant deployment is therefore unaffected by this change, and
      // configuring auth is what turns scoping on.
      const app = makeApp();
      const taskId = await submit(app, "", "m-anon-1");

      const other = await rpc(app, "someone-else", "GetTask", { id: taskId });
      expect((other.result as { id: string }).id).toBe(taskId);
    });
  });
});
