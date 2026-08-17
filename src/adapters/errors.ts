import { ErrorCodes } from "apcore-js";

const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL_ERROR = -32603;
const CODE_TASK_NOT_FOUND = -32001;

export interface JsonRpcError {
  code: number;
  message: string;
}

export class ErrorMapper {
  /** ErrorFormatter interface for apcore ErrorFormatterRegistry. */
  format(error: unknown, _context?: unknown): Record<string, unknown> {
    const rpcError = this.toJsonRpcError(error);
    return { code: rpcError.code, message: rpcError.message };
  }

  toJsonRpcError(error: unknown): JsonRpcError {
    // Sanitization rule 4: log the full, unsanitized error at ERROR level for
    // server-side diagnostics before any sanitization is applied (matches the
    // Python binding).
    console.error("Mapping error to JSON-RPC error:", error);

    if (error instanceof Error) {
      const code = (error as { code?: string }).code;

      if (code) {
        return this.handleApcoreError(error, code);
      }

      if (error.name === "TimeoutError" || error.constructor.name === "TimeoutError") {
        return { code: CODE_INTERNAL_ERROR, message: "Execution timeout" };
      }
    }

    return { code: CODE_INTERNAL_ERROR, message: "Internal server error" };
  }

  private handleApcoreError(error: Error, errorCode: string): JsonRpcError {
    if (errorCode === ErrorCodes.MODULE_NOT_FOUND) {
      const message = this.sanitizeMessage((error as { message: string }).message);
      return { code: CODE_METHOD_NOT_FOUND, message };
    }

    if (errorCode === ErrorCodes.SCHEMA_VALIDATION_ERROR) {
      // apcore raises the one code for output validation too, which the caller
      // can do nothing about -- see isServerSideSchemaError.
      if (isServerSideSchemaError((error as { message: string }).message)) {
        return { code: CODE_INTERNAL_ERROR, message: "Internal server error" };
      }
      const message = this.sanitizeMessage((error as { message: string }).message);
      return { code: CODE_INVALID_PARAMS, message };
    }

    if (errorCode === ErrorCodes.GENERAL_INVALID_INPUT) {
      const description = this.sanitizeMessage((error as { message: string }).message);
      return { code: CODE_INVALID_PARAMS, message: `Invalid input: ${description}` };
    }

    if (errorCode === ErrorCodes.ACL_DENIED) {
      return { code: CODE_TASK_NOT_FOUND, message: "Task not found" };
    }

    if (errorCode === ErrorCodes.MODULE_TIMEOUT) {
      return { code: CODE_INTERNAL_ERROR, message: "Execution timeout" };
    }

    if (errorCode === ErrorCodes.EXECUTION_CANCELLED) {
      return { code: CODE_INTERNAL_ERROR, message: "Execution cancelled" };
    }

    if (
      errorCode === ErrorCodes.CALL_DEPTH_EXCEEDED ||
      errorCode === ErrorCodes.CIRCULAR_CALL ||
      errorCode === ErrorCodes.CALL_FREQUENCY_EXCEEDED
    ) {
      return { code: CODE_INTERNAL_ERROR, message: "Safety limit exceeded" };
    }

    if (errorCode === ErrorCodes.CIRCUIT_BREAKER_OPEN || errorCode === ErrorCodes.TASK_LIMIT_EXCEEDED) {
      return { code: CODE_INTERNAL_ERROR, message: "Service temporarily unavailable" };
    }

    if (errorCode === ErrorCodes.MODULE_DISABLED) {
      return { code: CODE_INTERNAL_ERROR, message: "Module is currently disabled" };
    }

    if (
      errorCode === ErrorCodes.CONFIG_NAMESPACE_DUPLICATE ||
      errorCode === ErrorCodes.CONFIG_MOUNT_ERROR ||
      errorCode === ErrorCodes.CONFIG_BIND_ERROR
    ) {
      return { code: CODE_INTERNAL_ERROR, message: "Configuration error" };
    }

    return { code: CODE_INTERNAL_ERROR, message: "Internal server error" };
  }

  private sanitizeMessage(message: string): string {
    return sanitizeMessage(message);
  }
}

/**
 * Direction labels apcore puts at the front of a SCHEMA_VALIDATION_ERROR
 * message. apcore-js raises the code for input and output validation
 * (`builtin-steps.js`: ``validateSchema(schema, data, 'Input' | 'Output')``,
 * whose message is `` `${direction} validation failed` ``). Config validation is
 * not in this set: apcore-js raises `ConfigError` / `CONFIG_INVALID` for it,
 * which `handleApcoreError` already sends to the fixed internal string through
 * its catch-all.
 */
const SERVER_SIDE_SCHEMA_PREFIXES = ["Output validation failed"] as const;

/**
 * Whether a `SCHEMA_VALIDATION_ERROR` is about something the *server* produced
 * rather than something the caller sent.
 *
 * Reporting an output-validation failure as `-32602 Invalid params` tells the
 * caller to fix a request that was correct, and the default `aiGuidance` apcore
 * attaches to `SchemaValidationError` says "Input validation failed" and points
 * at a `details.errors` field an A2A caller never receives. Those are
 * server-side defects and belong behind the fixed internal string.
 *
 * The direction label apcore puts at the front of the message is the only signal
 * that exists, so this matches that prefix. Anything unrecognized keeps the
 * caller-facing detail -- including a module that raises the code itself with
 * its own wording, whose message srs FR-ERR-002 requires the caller to see.
 * Failing to recognize a server-side error therefore preserves the previous
 * behaviour; it never masks a caller-fixable one by mistake.
 */
export function isServerSideSchemaError(message: string): boolean {
  return SERVER_SIDE_SCHEMA_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * Whether {@link ErrorMapper.toJsonRpcError} forwards this error's own message
 * to the caller (sanitized), or replaces it with a fixed per-class string.
 *
 * This is the partition that decides whether a message may be *widened* -- with
 * `aiGuidance`, or anything else. It is deliberately not `userFixable`, which is
 * a different partition: six apcore codes carry `userFixable === true` while
 * falling into `handleApcoreError`'s catch-all (`VERSION_CONSTRAINT_INVALID`,
 * `BINDING_SCHEMA_INFERENCE_FAILED`, `BINDING_SCHEMA_MODE_CONFLICT`,
 * `BINDING_STRICT_SCHEMA_INCOMPATIBLE`, `DEPENDENCY_NOT_FOUND`,
 * `DEPENDENCY_VERSION_MISMATCH`), and appending guidance to those would extend
 * the fixed "Internal server error" string with internal detail that
 * {@link sanitizeMessage} does not strip (module ids, versions, env-var names,
 * hostnames). `userFixable` is also settable per-error by the module author,
 * which would let any module widen any fixed per-class string at will,
 * including the `ACL_DENIED` mask.
 *
 * `errorMapper message policy matches toJsonRpcError` locks this to the
 * branching in `ErrorMapper.handleApcoreError` across every apcore error code,
 * so the two cannot drift.
 */
export function carriesCallerDetail(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === ErrorCodes.MODULE_NOT_FOUND || code === ErrorCodes.GENERAL_INVALID_INPUT) {
    return true;
  }
  if (code === ErrorCodes.SCHEMA_VALIDATION_ERROR) {
    return !isServerSideSchemaError(String((error as { message?: string }).message ?? ""));
  }
  return false;
}

/**
 * Strip file paths, traceback lines and excess whitespace from text bound for a
 * caller, then truncate to 500 characters. Module-level so the task-status
 * surface (`server/executor.ts`) applies exactly the same redaction as the
 * JSON-RPC surface.
 */
export function sanitizeMessage(message: string): string {
  // Strip file paths (Unix absolute paths and ~ paths)
  let sanitized = message.replace(/~?\/\S*/g, "");
  // Strip traceback lines (matching Python's behavior)
  sanitized = sanitized.replace(/^.*(?:Traceback|File "|line \d+).*$/gm, "");
  return sanitized.replace(/\s+/g, " ").trim().slice(0, 500);
}
