/** Conformance — Algorithm A-SKILL: missing/invalid skillId & unparseable parts. */
import { describe, it, expect } from "vitest";
import { ApCoreAgentExecutor } from "../../src/server/executor.js";
import { PartConverter } from "../../src/adapters/parts.js";
import { loadFixture } from "./_spec.js";
import { classify, makeContext, makeEventBus, makeRegistry, singleExecutor, stateValue } from "./_server.js";

const fixture = loadFixture("skill_resolution.json");

(fixture ? describe : describe.skip)("A-SKILL: skill resolution", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.test_cases ?? []) {
    it(c.id, async () => {
      const agent = new ApCoreAgentExecutor({
        executor: singleExecutor(),
        partConverter: new PartConverter(),
        registry: makeRegistry(["math.add"]),
      });
      const bus = makeEventBus();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await agent.execute(makeContext(c.params) as any, bus);

      const events = bus.events.map(classify);
      const failed = events.filter(
        (e) => e.kind === "statusUpdate" && e.fields.state === stateValue(c.expected_task_state),
      );
      expect(failed.length, `${c.id}: no ${c.expected_task_state}; got ${JSON.stringify(events)}`).toBeGreaterThan(0);
      const message = failed[0].fields.message as string;
      for (const needle of c.expected_status_message ?? []) expect(message).toContain(needle);
    });
  }
});
