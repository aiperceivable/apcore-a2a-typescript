import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import type { AgentCard } from "@a2a-js/sdk";
import { createExplorerRouter } from "../../src/explorer/handler.js";

const mockCard: AgentCard = {
  name: "TestAgent",
  description: "Test",
  version: "1.0.0",
  url: "http://localhost:3000",
  protocolVersion: "0.2.1",
  skills: [],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
};

function buildApp() {
  const app = express();
  app.use("/explorer", createExplorerRouter(mockCard));
  return app;
}

describe("Explorer Router", () => {
  it("GET / returns HTML", async () => {
    const app = buildApp();
    const res = await request(app).get("/explorer/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("<!DOCTYPE html>");
    expect(res.text).toContain("A2A Explorer");
  });

  it("GET /agent-card returns agent card JSON", async () => {
    const app = buildApp();
    const res = await request(app).get("/explorer/agent-card");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("TestAgent");
    expect(res.body.version).toBe("1.0.0");
  });
});
