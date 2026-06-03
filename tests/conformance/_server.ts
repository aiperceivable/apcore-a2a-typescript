/**
 * Server-level helpers for the A-SKILL / A-STREAM conformance runners. Drive
 * ApCoreAgentExecutor (the unit that emits A2A events in the Python/TS SDKs)
 * with a stub executor and collect the resulting event stream.
 */
import { vi } from "vitest";
import { Part, TaskState } from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Registry } from "../../src/adapters/agent-card.js";

export const TASK_ID = "task-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPart(spec: any): Part {
  if ("text" in spec) return Part.fromJSON({ text: spec.text });
  if ("data" in spec) return Part.fromJSON({ data: spec.data });
  if ("url" in spec) return Part.fromJSON({ url: spec.url });
  throw new Error(`unrecognized part spec: ${JSON.stringify(spec)}`);
}

/** Project an in-memory Part ({content:{$case,value}}) to the fixture's oneof form. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function projectPart(part: any): Record<string, unknown> {
  const c = part.content;
  if (!c) return {};
  if (c.$case === "text") return { text: c.value };
  if (c.$case === "data") return { data: c.value };
  return { [c.$case]: c.value };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeContext(params: any, taskId = TASK_ID): any {
  const msg = params.message;
  return {
    taskId,
    contextId: "ctx-1",
    userMessage: {
      messageId: msg.messageId ?? "m1",
      role: "user" as const,
      parts: (msg.parts ?? []).map(buildPart),
      // skillId lives in params.metadata (sibling of message) on the A2A wire;
      // fall back to message.metadata. The executor reads userMessage.metadata.
      metadata: params.metadata ?? msg.metadata ?? {},
    },
  };
}

export function makeEventBus(): ExecutionEventBus & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    publish: vi.fn((event: unknown) => events.push(event)),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    finished: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

export function makeRegistry(modules: string[]): Registry {
  return {
    list: () => modules,
    getDefinition: (id: string) =>
      modules.includes(id)
        ? { module_id: id, description: `Module ${id}`, input_schema: { type: "object" } }
        : null,
  };
}

export function singleExecutor(result: Record<string, unknown> = {}) {
  return { callAsync: vi.fn().mockResolvedValue(result) };
}

export function streamingExecutor(opts: { chunks?: unknown[]; error?: unknown }) {
  return {
    async callAsync(): Promise<Record<string, unknown>> {
      return {};
    },
    async *stream(): AsyncGenerator<unknown> {
      if (opts.error) throw opts.error;
      for (const chunk of opts.chunks ?? []) yield chunk;
    },
  };
}

/** Numeric value of a TaskState name (e.g. "TASK_STATE_COMPLETED"). */
export function stateValue(name: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (TaskState as any)[name];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function statusMessage(status: any): string {
  const content = status?.message?.parts?.[0]?.content;
  return content?.$case === "text" ? content.value : "";
}

/** Map an AgentExecutionEvent ({kind,data}) to (kind, fields) for matching. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classify(event: any): { kind: string; fields: Record<string, unknown> } {
  const data = event.data;
  if (event.kind === "task") {
    return { kind: "task", fields: { state: data.status?.state } };
  }
  if (event.kind === "artifactUpdate") {
    const parts = data.artifact?.parts ?? [];
    return {
      kind: "artifactUpdate",
      fields: { append: !!data.append, lastChunk: !!data.lastChunk, empty_parts: parts.length === 0 },
    };
  }
  if (event.kind === "statusUpdate") {
    return { kind: "statusUpdate", fields: { state: data.status?.state, message: statusMessage(data.status) } };
  }
  return { kind: event.kind, fields: {} };
}
