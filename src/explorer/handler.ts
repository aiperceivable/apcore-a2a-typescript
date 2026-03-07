import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentCard } from "@a2a-js/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// Resolve HTML relative to this file's location.
// In source: src/explorer/handler.ts -> src/explorer/index.html
// In dist:   dist/explorer/handler.js -> dist/explorer/index.html (copied by build)
const HTML_PATH = join(__dir, "index.html");

let cachedHtml: string | null = null;

function getHtml(): string {
  if (!cachedHtml) {
    cachedHtml = readFileSync(HTML_PATH, "utf-8");
  }
  return cachedHtml;
}

export function createExplorerRouter(agentCard: AgentCard): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.type("html").send(getHtml());
  });

  router.get("/agent-card", (_req, res) => {
    res.json(agentCard);
  });

  return router;
}
