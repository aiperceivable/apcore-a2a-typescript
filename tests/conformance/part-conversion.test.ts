/** Conformance — Algorithm A-PART: Part <-> module input/output parity. */
import { describe, it, expect } from "vitest";
import { PartConverter } from "../../src/adapters/parts.js";
import { loadFixture, partialMatch } from "./_spec.js";
import { buildPart, projectPart } from "./_server.js";

const fixture = loadFixture("part_conversion.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function descriptorFor(c: any) {
  return c.input_schema != null ? { module_id: "m", input_schema: c.input_schema } : null;
}

(fixture ? describe : describe.skip)("A-PART: part conversion", () => {
  const conv = new PartConverter();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.test_cases ?? []) {
    it(c.id, () => {
      if (c.direction === "output_to_parts") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const art = conv.outputToParts(c.input, c.task_id ?? "") as any;
        if (c.expected_artifact_id) expect(art.artifactId).toBe(c.expected_artifact_id);
        const parts = (art.parts ?? []).map(projectPart);
        const err = partialMatch(c.expected_parts, parts);
        expect(err, `${c.id}: ${err}`).toBeNull();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = conv.partsToInput(c.parts.map(buildPart), descriptorFor(c) as any);
        if (c.expected_input !== null && typeof c.expected_input === "object") {
          const err = partialMatch(c.expected_input, result);
          expect(err, `${c.id}: ${err}`).toBeNull();
        } else {
          expect(result).toBe(c.expected_input);
        }
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture?.error_cases ?? []) {
    it(c.id, () => {
      let thrown: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conv.partsToInput(c.parts.map(buildPart), descriptorFor(c) as any);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${c.id}: expected a thrown error`).toBeTruthy();
      for (const needle of c.expected_error_message ?? []) expect(String(thrown)).toContain(needle);
    });
  }
});
