/** Conformance — Algorithm A-STREAM: streaming event-sequence parity. */
import { describe, it, expect } from "vitest";
import { ApCoreAgentExecutor } from "../../src/server/executor.js";
import { PartConverter } from "../../src/adapters/parts.js";
import { loadFixture } from "./_spec.js";
import { classify, makeContext, makeEventBus, makeRegistry, streamingExecutor, stateValue } from "./_server.js";

const fixture = loadFixture("streaming_events.json");

const codeByName: Record<string, string> = {
  ModuleExecuteError: "MODULE_EXECUTE_ERROR",
  ModuleTimeoutError: "MODULE_TIMEOUT",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildExecutor(c: any) {
  if (c.module_error) {
    const err = Object.assign(new Error(c.module_error.message ?? "boom"), {
      code: codeByName[c.module_error.exception],
    });
    return streamingExecutor({ error: err });
  }
  return streamingExecutor({ chunks: c.module_chunks ?? [] });
}

(fixture ? describe : describe.skip)("A-STREAM: streaming events", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.test_cases ?? []) {
    it(c.id, async () => {
      const skillId = c.params.metadata.skillId;
      const agent = new ApCoreAgentExecutor({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        executor: buildExecutor(c) as any,
        partConverter: new PartConverter(),
        registry: makeRegistry([skillId]),
      });
      const bus = makeEventBus();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await agent.execute(makeContext(c.params) as any, bus);

      const events = bus.events.map(classify);

      if (c.expected_start_state) {
        const startStates = events
          .filter((e) => e.kind === "task" || e.kind === "statusUpdate")
          .map((e) => e.fields.state);
        expect(startStates, `${c.id}: start; got ${JSON.stringify(events)}`).toContain(stateValue(c.expected_start_state));
      }

      const artifactUpdates = events.filter((e) => e.kind === "artifactUpdate");
      const markers = artifactUpdates.filter((e) => e.fields.lastChunk);
      const nonMarker = artifactUpdates.filter((e) => !e.fields.lastChunk);

      if (c.expected_min_artifact_updates != null) {
        expect(nonMarker.length, `${c.id}: artifacts; got ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(
          c.expected_min_artifact_updates,
        );
      }
      if (c.expected_terminal_marker === true) {
        expect(markers.length, `${c.id}: marker`).toBeGreaterThan(0);
        expect(markers[markers.length - 1].fields.empty_parts).toBe(true);
      } else if (c.expected_terminal_marker === false) {
        expect(markers.length, `${c.id}: unexpected marker`).toBe(0);
      }

      const finalStates = events.filter((e) => e.kind === "statusUpdate").map((e) => e.fields.state);
      expect(finalStates[finalStates.length - 1], `${c.id}: final; got ${JSON.stringify(events)}`).toBe(
        stateValue(c.expected_final_state),
      );

      if (c.expected_status_message || c.expected_status_message_excludes) {
        const failed = events.find(
          (e) => e.kind === "statusUpdate" && e.fields.state === stateValue("TASK_STATE_FAILED"),
        );
        expect(failed, `${c.id}: no FAILED`).toBeTruthy();
        const message = failed!.fields.message as string;
        for (const needle of c.expected_status_message ?? []) expect(message).toContain(needle);
        for (const forbidden of c.expected_status_message_excludes ?? []) expect(message).not.toContain(forbidden);
      }
    });
  }
});
