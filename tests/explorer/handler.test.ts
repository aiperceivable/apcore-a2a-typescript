import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import type { AgentCard } from "@a2a-js/sdk";
import { createExplorerRouter } from "../../src/explorer/handler.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const minimalCard: AgentCard = {
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

const cardWithSkills: AgentCard = {
  name: "SkillAgent",
  description: "Agent with multiple skills",
  version: "2.0.0",
  url: "http://localhost:8000",
  protocolVersion: "0.2.1",
  skills: [
    {
      id: "text_echo",
      name: "Text Echo",
      description: "Echo input text back",
      tags: ["text", "utility"],
      inputModes: ["text/plain", "application/json"],
      outputModes: ["text/plain"],
      examples: ["Echo hello", "Echo world"],
    },
    {
      id: "math_calc",
      name: "Math Calc",
      description: "Perform arithmetic",
      tags: ["math"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      examples: [],
    },
    {
      id: "greeting",
      name: "Greeting",
      description: "Generate a personalized greeting",
      tags: ["text", "fun"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      examples: ["Greet Alice"],
    },
  ],
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
};

function buildApp(card: AgentCard = minimalCard, prefix = "/explorer") {
  const app = express();
  app.use(prefix, createExplorerRouter(card));
  return app;
}

// ── Shared HTML cache (fetched once, used by all HTML content tests) ────────

let sharedHtml: string;

beforeAll(async () => {
  const res = await request(buildApp()).get("/explorer/");
  sharedHtml = res.text;
});

// ── Route Tests ─────────────────────────────────────────────────────────────

describe("Explorer Router", () => {
  describe("GET / — HTML page", () => {
    it("returns 200 with HTML content-type", async () => {
      const res = await request(buildApp()).get("/explorer/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/html/);
    });

    it("returns valid HTML document", async () => {
      const res = await request(buildApp()).get("/explorer/");
      expect(res.text).toContain("<!DOCTYPE html>");
      expect(res.text).toContain("<html");
      expect(res.text).toContain("</html>");
    });

    it("contains page title", async () => {
      const res = await request(buildApp()).get("/explorer/");
      expect(res.text).toContain("<title>A2A Explorer</title>");
    });
  });

  describe("GET /agent-card — JSON endpoint", () => {
    it("returns agent card JSON with minimal card", async () => {
      const res = await request(buildApp()).get("/explorer/agent-card");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("TestAgent");
      expect(res.body.version).toBe("1.0.0");
      expect(res.body.skills).toEqual([]);
    });

    it("returns agent card with skills", async () => {
      const app = buildApp(cardWithSkills);
      const res = await request(app).get("/explorer/agent-card");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("SkillAgent");
      expect(res.body.skills).toHaveLength(3);
      expect(res.body.skills[0].id).toBe("text_echo");
      expect(res.body.skills[1].id).toBe("math_calc");
      expect(res.body.skills[2].id).toBe("greeting");
    });

    it("returns full agent card structure", async () => {
      const app = buildApp(cardWithSkills);
      const res = await request(app).get("/explorer/agent-card");

      expect(res.body.protocolVersion).toBe("0.2.1");
      expect(res.body.url).toBe("http://localhost:8000");
      expect(res.body.capabilities.streaming).toBe(true);
      expect(res.body.defaultInputModes).toContain("text/plain");
    });
  });

  describe("custom prefix", () => {
    it("works with custom prefix", async () => {
      const app = buildApp(minimalCard, "/tools");
      const htmlRes = await request(app).get("/tools/");
      const cardRes = await request(app).get("/tools/agent-card");

      expect(htmlRes.status).toBe(200);
      expect(cardRes.status).toBe(200);
      expect(cardRes.body.name).toBe("TestAgent");
    });
  });
});

// ── HTML Structure Tests ────────────────────────────────────────────────────

describe("Explorer HTML — Layout", () => {
  it("contains header with title and A2A badge", () => {
    expect(sharedHtml).toContain("APCore A2A Agent Explorer");
    expect(sharedHtml).toContain('class="badge"');
    expect(sharedHtml).toContain(">A2A<");
  });

  it("contains agent name header placeholder", () => {
    expect(sharedHtml).toContain('id="agent-name-header"');
  });

  it("contains sidebar with Agent Card and Skills sections", () => {
    expect(sharedHtml).toContain("Agent Card");
    expect(sharedHtml).toContain('id="card-info"');
    expect(sharedHtml).toContain("Skills");
    expect(sharedHtml).toContain('id="skills-list"');
    expect(sharedHtml).toContain('id="skill-count"');
  });

  it("contains two-column layout", () => {
    expect(sharedHtml).toContain('class="layout"');
    expect(sharedHtml).toContain('class="sidebar"');
    expect(sharedHtml).toContain('class="main"');
  });

  it("contains responsive breakpoint", () => {
    expect(sharedHtml).toContain("@media (max-width: 768px)");
    expect(sharedHtml).toContain("grid-template-columns: 1fr");
  });
});

describe("Explorer HTML — Auth Bar", () => {
  it("contains auth bar with token input", () => {
    expect(sharedHtml).toContain('class="auth-bar"');
    expect(sharedHtml).toContain('id="auth-token"');
    expect(sharedHtml).toContain("Authorization");
  });

  it("contains auth status indicator", () => {
    expect(sharedHtml).toContain('id="auth-status"');
    expect(sharedHtml).toContain("No token");
    expect(sharedHtml).toContain("auth-unlocked");
  });

  it("contains placeholder with JWT hint", () => {
    expect(sharedHtml).toContain("Bearer eyJhbGci");
  });

  it("has auth-locked and auth-unlocked CSS classes", () => {
    expect(sharedHtml).toContain(".auth-locked");
    expect(sharedHtml).toContain(".auth-unlocked");
  });
});

describe("Explorer HTML — Message Composer", () => {
  it("contains Message Composer card", () => {
    expect(sharedHtml).toContain("Message Composer");
  });

  it("contains skill selector", () => {
    expect(sharedHtml).toContain('id="skill-select"');
  });

  it("contains message textarea", () => {
    expect(sharedHtml).toContain('id="message-input"');
    expect(sharedHtml).toContain("text or JSON parts array");
  });

  it("contains context ID input", () => {
    expect(sharedHtml).toContain('id="context-id"');
    expect(sharedHtml).toContain("Auto-generated if empty");
  });

  it("contains Send and Stream buttons", () => {
    expect(sharedHtml).toContain("sendMessage()");
    expect(sharedHtml).toContain("Send (message/send)");
    expect(sharedHtml).toContain("streamMessage()");
    expect(sharedHtml).toContain("Stream (message/stream)");
  });

  it("contains Clear button", () => {
    expect(sharedHtml).toContain("clearComposer()");
    expect(sharedHtml).toContain("Clear");
  });

  it("contains result area and cURL container", () => {
    expect(sharedHtml).toContain('id="send-result"');
    expect(sharedHtml).toContain('id="send-curl"');
  });

  it("contains composer status bar", () => {
    expect(sharedHtml).toContain('id="composer-status"');
  });
});

describe("Explorer HTML — SSE Stream Viewer", () => {
  it("contains SSE Stream Viewer card", () => {
    expect(sharedHtml).toContain("SSE Stream Viewer");
  });

  it("contains events container", () => {
    expect(sharedHtml).toContain('id="sse-events"');
    expect(sharedHtml).toContain("No stream events yet.");
  });

  it("contains clear SSE button", () => {
    expect(sharedHtml).toContain("clearSSE()");
  });

  it("has event type CSS classes", () => {
    expect(sharedHtml).toContain(".et-status");
    expect(sharedHtml).toContain(".et-artifact");
    expect(sharedHtml).toContain(".et-error");
    expect(sharedHtml).toContain(".et-other");
  });

  it("has state badge CSS classes", () => {
    expect(sharedHtml).toContain(".s-working");
    expect(sharedHtml).toContain(".s-completed");
    expect(sharedHtml).toContain(".s-failed");
    expect(sharedHtml).toContain(".s-canceled");
    expect(sharedHtml).toContain(".s-submitted");
  });
});

describe("Explorer HTML — Task Viewer", () => {
  it("contains Task Viewer card", () => {
    expect(sharedHtml).toContain("Task Viewer");
  });

  it("contains task ID input", () => {
    expect(sharedHtml).toContain('id="task-id-input"');
    expect(sharedHtml).toContain("Enter task ID");
  });

  it("contains Fetch and Cancel buttons", () => {
    expect(sharedHtml).toContain("getTask()");
    expect(sharedHtml).toContain("Fetch (tasks/get)");
    expect(sharedHtml).toContain("cancelTask()");
    expect(sharedHtml).toContain("Cancel (tasks/cancel)");
  });

  it("contains task result area", () => {
    expect(sharedHtml).toContain('id="task-result"');
  });

  it("contains task status bar", () => {
    expect(sharedHtml).toContain('id="task-status"');
  });
});

// ── JavaScript Function Tests ───────────────────────────────────────────────

describe("Explorer HTML — JavaScript functions", () => {
  it("contains init function that fetches agent-card", () => {
    expect(sharedHtml).toContain("async function init()");
    expect(sharedHtml).toContain('EXPLORER_PREFIX + "/agent-card"');
  });

  it("contains renderCard function", () => {
    expect(sharedHtml).toContain("function renderCard(card)");
  });

  it("contains renderSkills function", () => {
    expect(sharedHtml).toContain("function renderSkills(skills)");
  });

  it("contains populateSkillSelect function", () => {
    expect(sharedHtml).toContain("function populateSkillSelect(skills)");
  });

  it("contains esc function for HTML escaping", () => {
    expect(sharedHtml).toContain("function esc(s)");
    expect(sharedHtml).toContain("&amp;");
    expect(sharedHtml).toContain("&lt;");
    expect(sharedHtml).toContain("&gt;");
    expect(sharedHtml).toContain("&quot;");
  });

  it("contains getAuthHeaders function using auth-token input", () => {
    expect(sharedHtml).toContain("function getAuthHeaders()");
    expect(sharedHtml).toContain("authInput.value.trim()");
  });

  it("contains buildMessageParams function", () => {
    expect(sharedHtml).toContain("function buildMessageParams(skillId, text, contextId)");
    expect(sharedHtml).toContain("metadata: { skillId }");
  });

  it("contains sendMessage function with JSON-RPC message/send", () => {
    expect(sharedHtml).toContain("async function sendMessage()");
    expect(sharedHtml).toContain('"message/send"');
  });

  it("contains streamMessage function with JSON-RPC message/stream", () => {
    expect(sharedHtml).toContain("function streamMessage()");
    expect(sharedHtml).toContain('"message/stream"');
  });

  it("contains appendSSEEvent function", () => {
    expect(sharedHtml).toContain("function appendSSEEvent(type, dataStr)");
  });

  it("contains getTask function with JSON-RPC tasks/get", () => {
    expect(sharedHtml).toContain("async function getTask()");
    expect(sharedHtml).toContain('"tasks/get"');
  });

  it("contains cancelTask function with JSON-RPC tasks/cancel", () => {
    expect(sharedHtml).toContain("async function cancelTask()");
    expect(sharedHtml).toContain('"tasks/cancel"');
  });

  it("contains generateId function", () => {
    expect(sharedHtml).toContain("function generateId()");
    expect(sharedHtml).toContain("crypto.randomUUID");
  });

  it("contains taskStateBadge function", () => {
    expect(sharedHtml).toContain("function taskStateBadge(state)");
  });

  it("contains clearComposer function that also clears cURL", () => {
    expect(sharedHtml).toContain("function clearComposer()");
    expect(sharedHtml).toContain('getElementById("send-curl").innerHTML = ""');
  });

  it("contains clearSSE function", () => {
    expect(sharedHtml).toContain("function clearSSE()");
  });
});

describe("Explorer HTML — Auth bar JavaScript", () => {
  it("contains updateAuthStatus function", () => {
    expect(sharedHtml).toContain("function updateAuthStatus()");
  });

  it("sets Token set text when token present", () => {
    expect(sharedHtml).toContain('"Token set"');
    expect(sharedHtml).toContain('"auth-status auth-locked"');
  });

  it("sets No token text when token empty", () => {
    expect(sharedHtml).toContain('"No token"');
    expect(sharedHtml).toContain('"auth-status auth-unlocked"');
  });

  it("persists token to sessionStorage", () => {
    expect(sharedHtml).toContain('sessionStorage.setItem("auth_token"');
  });

  it("restores token from sessionStorage on load", () => {
    expect(sharedHtml).toContain('sessionStorage.getItem("auth_token")');
    expect(sharedHtml).toContain("if (savedToken) authInput.value = savedToken");
  });

  it("removes token from sessionStorage when cleared", () => {
    expect(sharedHtml).toContain('sessionStorage.removeItem("auth_token")');
  });

  it("listens for input events on auth-token", () => {
    expect(sharedHtml).toContain('authInput.addEventListener("input", updateAuthStatus)');
  });

  it("auto-prepends Bearer prefix when missing", () => {
    expect(sharedHtml).toContain('token.toLowerCase().startsWith("bearer ")');
    expect(sharedHtml).toContain('"Bearer " + token');
  });
});

describe("Explorer HTML — cURL generation", () => {
  it("contains buildCurlCommand function", () => {
    expect(sharedHtml).toContain("function buildCurlCommand(body)");
  });

  it("generates curl -X POST command", () => {
    expect(sharedHtml).toContain("curl -X POST");
  });

  it("includes Content-Type header in cURL", () => {
    expect(sharedHtml).toContain("Content-Type: application/json");
  });

  it("includes Authorization header when token set", () => {
    expect(sharedHtml).toContain("Authorization:");
  });

  it("contains renderCurl function", () => {
    expect(sharedHtml).toContain("function renderCurl(parentEl, body)");
  });

  it("renders cURL section with copy button via JS template", () => {
    expect(sharedHtml).toContain("curl-section");
    expect(sharedHtml).toContain("curl-block");
    expect(sharedHtml).toContain("curl-cmd");
    expect(sharedHtml).toContain("copy-btn");
    expect(sharedHtml).toContain(">Copy<");
  });

  it("uses navigator.clipboard for copy", () => {
    expect(sharedHtml).toContain("navigator.clipboard.writeText");
  });

  it("shows Copied! feedback after successful copy", () => {
    expect(sharedHtml).toContain('"Copied!"');
  });

  it("sendMessage renders cURL in finally block", () => {
    expect(sharedHtml).toContain('getElementById("send-curl")');
    expect(sharedHtml).toContain("renderCurl(curlContainer, body)");
  });

  it("has CSS styles for curl-block", () => {
    expect(sharedHtml).toContain(".curl-block");
    expect(sharedHtml).toContain(".copy-btn");
  });
});

describe("Explorer HTML — Keyboard shortcuts", () => {
  it("registers Ctrl+Enter / Cmd+Enter shortcut", () => {
    expect(sharedHtml).toContain('addEventListener("keydown"');
    expect(sharedHtml).toContain("e.ctrlKey || e.metaKey");
    expect(sharedHtml).toContain('e.key === "Enter"');
  });

  it("triggers sendMessage when focused on message-input", () => {
    expect(sharedHtml).toContain('focused.id === "message-input"');
    expect(sharedHtml).toContain("sendMessage()");
  });
});

describe("Explorer HTML — SSE stream parsing", () => {
  it("uses ReadableStream reader for SSE", () => {
    expect(sharedHtml).toContain("res.body.getReader()");
    expect(sharedHtml).toContain("new TextDecoder()");
  });

  it("parses SSE event: and data: fields", () => {
    expect(sharedHtml).toContain('line.startsWith("event:")');
    expect(sharedHtml).toContain('line.startsWith("data:")');
  });

  it("splits SSE blocks by double newline", () => {
    expect(sharedHtml).toContain('"\\n\\n"');
  });

  it("auto-populates task ID from stream events", () => {
    expect(sharedHtml).toContain('getElementById("task-id-input").value');
  });

  it("extracts state for badge rendering", () => {
    expect(sharedHtml).toContain("parsed?.result?.status?.state");
    expect(sharedHtml).toContain("parsed?.status?.state");
  });

  it("auto-scrolls events container", () => {
    expect(sharedHtml).toContain("eventsDiv.scrollTop = eventsDiv.scrollHeight");
  });
});

// ── Integration with Factory ────────────────────────────────────────────────

describe("Explorer integration with A2AServerFactory", () => {
  // Lazy import to avoid pulling in heavy deps at module level
  async function createFactoryApp(explorerEnabled: boolean, prefix?: string) {
    const { A2AServerFactory } = await import("../../src/server/factory.js");
    const registry = {
      list: () => ["echo"],
      getDefinition: () => ({
        module_id: "echo",
        description: "Echo module",
        input_schema: { type: "object" },
      }),
    };
    const executor = {
      callAsync: async () => ({ result: "ok" }),
    };
    const factory = new A2AServerFactory();
    const { app } = factory.create(registry, executor, {
      name: "TestAgent",
      description: "Test",
      version: "1.0.0",
      url: "http://localhost:3000",
      explorer: explorerEnabled,
      explorerPrefix: prefix,
    });
    return app;
  }

  it("mounts explorer at /explorer when enabled", async () => {
    const app = await createFactoryApp(true);
    const htmlRes = await request(app).get("/explorer/");
    const cardRes = await request(app).get("/explorer/agent-card");

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers["content-type"]).toMatch(/html/);
    expect(htmlRes.text).toContain("APCore A2A Agent Explorer");

    expect(cardRes.status).toBe(200);
    expect(cardRes.body.name).toBe("TestAgent");
    expect(cardRes.body.skills).toHaveLength(1);
  });

  it("does not mount explorer when disabled", async () => {
    const app = await createFactoryApp(false);
    const res = await request(app).get("/explorer/");

    expect(res.status).toBe(404);
  });

  it("mounts explorer at custom prefix", async () => {
    const app = await createFactoryApp(true, "/ui");
    const htmlRes = await request(app).get("/ui/");
    const cardRes = await request(app).get("/ui/agent-card");

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.text).toContain("APCore A2A Agent Explorer");
    expect(cardRes.status).toBe(200);
    expect(cardRes.body.name).toBe("TestAgent");
  });

  it("explorer agent-card reflects registered skills", async () => {
    const app = await createFactoryApp(true);
    const res = await request(app).get("/explorer/agent-card");

    expect(res.body.skills).toHaveLength(1);
    expect(res.body.skills[0].id).toBe("echo");
    expect(res.body.skills[0].description).toBe("Echo module");
  });

  it("explorer coexists with health endpoint", async () => {
    const app = await createFactoryApp(true);

    const explorerRes = await request(app).get("/explorer/");
    const healthRes = await request(app).get("/health");

    expect(explorerRes.status).toBe(200);
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe("healthy");
  });
});
