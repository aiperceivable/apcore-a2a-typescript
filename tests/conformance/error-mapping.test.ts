/** Conformance — Algorithm A-ERR: apcore exception -> JSON-RPC error parity. */
import { describe, it, expect } from "vitest";
import { ErrorCodes } from "apcore-js";
import { ErrorMapper } from "../../src/adapters/errors.js";
import { loadFixture } from "./_spec.js";

const fixture = loadFixture("error_mapping.json");

const codeByName: Record<string, string> = {
  ModuleNotFoundError: ErrorCodes.MODULE_NOT_FOUND,
  SchemaValidationError: ErrorCodes.SCHEMA_VALIDATION_ERROR,
  ACLDeniedError: ErrorCodes.ACL_DENIED,
  ApprovalDeniedError: ErrorCodes.APPROVAL_DENIED,
  ApprovalTimeoutError: ErrorCodes.APPROVAL_TIMEOUT,
  ApprovalPendingError: ErrorCodes.APPROVAL_PENDING,
  ModuleExecuteError: ErrorCodes.MODULE_EXECUTE_ERROR,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildError(spec: any): unknown {
  if (spec.exception === "RuntimeError") return new Error(spec.message ?? "boom");
  let message = spec.message ?? "";
  if (spec.exception === "SchemaValidationError") {
    message =
      Object.entries(spec.errors ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ") || "validation failed";
  } else if (spec.exception === "ACLDeniedError") {
    message = `caller ${spec.caller} denied access to ${spec.module}`;
  }
  return Object.assign(new Error(message), { code: codeByName[spec.exception] });
}

(fixture ? describe : describe.skip)("A-ERR: error mapping", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Cases about the server's tasks/* path are not reconstructible as an apcore
  // exception; the task-scoping tests assert those.
  for (const c of (fixture?.error_cases ?? []).filter(
    (e: { surface?: string }) => e.surface !== "server",
  )) {
    it(c.id, () => {
      const rpc = new ErrorMapper().toJsonRpcError(buildError(c.input));
      expect(rpc.code).toBe(c.expected_error_code);
      for (const needle of c.expected_error_message ?? []) expect(rpc.message).toContain(needle);
      for (const forbidden of c.expected_message_excludes ?? []) expect(rpc.message).not.toContain(forbidden);
    });
  }
});
