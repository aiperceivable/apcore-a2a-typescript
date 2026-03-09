/**
 * Echo text back — a minimal read-only module for testing.
 */

import { Type } from "@sinclair/typebox";
import { DEFAULT_ANNOTATIONS, type ModuleAnnotations, type ModuleExample, type Context } from "apcore-js";

const inputSchema = Type.Object({
  text: Type.String({ description: "Text to echo back" }),
  uppercase: Type.Boolean({ default: false, description: "Convert to uppercase" }),
});

const outputSchema = Type.Object({
  echoed: Type.String({ description: "The echoed text" }),
  length: Type.Integer({ description: "Character count" }),
});

const annotations: ModuleAnnotations = {
  ...DEFAULT_ANNOTATIONS,
  readonly: true,
  idempotent: true,
  openWorld: false,
};

export default {
  inputSchema,
  outputSchema,
  description: "Echo input text back, optionally converting to uppercase",
  tags: ["text", "utility"],
  annotations,
  examples: [
    { title: '{"text": "Hello world"}', inputs: { text: "Hello world" }, output: { echoed: "Hello world", length: 11 } },
    { title: '{"text": "hello", "uppercase": true}', inputs: { text: "hello", uppercase: true }, output: { echoed: "HELLO", length: 5 } },
  ] satisfies ModuleExample[],

  execute(inputs: Record<string, unknown>, _context: Context): Record<string, unknown> {
    let text = inputs.text as string;
    if (inputs.uppercase) {
      text = text.toUpperCase();
    }
    return { echoed: text, length: text.length };
  },
};
