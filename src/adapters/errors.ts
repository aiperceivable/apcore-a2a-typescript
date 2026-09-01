import { ErrorCodes } from "apcore-js";

const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL_ERROR = -32603;
/**
 * A2A 1.0 `TaskNotFoundError`. Reserved for an unknown task id or one owned by
 * another principal — deliberately indistinguishable from each other, and no
 * longer produced for an authorization refusal (see {@link CODE_ACCESS_DENIED}).
 */
export const CODE_TASK_NOT_FOUND = -32001;

// Governance refusal codes (srs FR-ERR-003 / FR-ERR-009 / FR-ERR-010).
//
// A2A 1.0 reserves -32001..-32009; JSON-RPC 2.0 leaves -32000..-32099 to the
// implementation. These three sit above A2A's reserved block, with room for it
// to grow, and are the "JSON-RPC custom error" A2A §13.2 names as the example
// for this binding.
//
// apcore distinguishes these three refusals from each other and from every
// other failure. Collapsing them onto -32001 (which means "unknown or non-owned
// task id") or -32603 (which every agent reads as "retry me") told the caller a
// *different* failure had happened, one whose correct response is the opposite
// of the real one.
export const CODE_ACCESS_DENIED = -32040;
export const CODE_APPROVAL_DENIED = -32041;
export const CODE_APPROVAL_TIMEOUT = -32042;

/**
 * The three governance refusal codes, each with its JSON-RPC code and the fixed
 * message it reports by default.
 *
 * `APPROVAL_PENDING` is deliberately absent: it is a resumable pause carrying
 * the `approvalId` the caller resumes with, handled by the executor before it
 * ever reaches the mapper (srs FR-EXE-002). Sweeping it in here would turn that
 * pause into a terminal failure.
 */
const GOVERNANCE_REFUSALS: ReadonlyMap<string, { code: number; message: string }> = new Map([
  [ErrorCodes.ACL_DENIED, { code: CODE_ACCESS_DENIED, message: "Access denied" }],
  [ErrorCodes.APPROVAL_DENIED, { code: CODE_APPROVAL_DENIED, message: "Approval denied" }],
  [ErrorCodes.APPROVAL_TIMEOUT, { code: CODE_APPROVAL_TIMEOUT, message: "Approval timed out" }],
]);

/** Whether an apcore error code is one of the three governance refusals. */
export function isGovernanceRefusal(code: string | undefined): boolean {
  return code !== undefined && GOVERNANCE_REFUSALS.has(code);
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export class ErrorMapper {
  /**
   * @param discloseRefusalReason Forward apcore's own message for the three
   *   governance refusal codes instead of the fixed per-class string
   *   (srs FR-ERR-011). Off by default. The code never changes with the flag —
   *   what a refusal *is* does not depend on how much a deployment chooses to
   *   say about it.
   */
  constructor(readonly discloseRefusalReason: boolean = false) {}

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

  /**
   * Caller-facing message for a governance refusal.
   *
   * Default: the fixed per-class string. With `discloseRefusalReason`
   * (srs FR-ERR-011): apcore's own message, through the same sanitizer every
   * other forwarded message goes through. An empty or whitespace-only apcore
   * message falls back to the fixed string rather than sending the caller
   * nothing.
   */
  private refusalMessage(fixed: string, error: Error): string {
    if (!this.discloseRefusalReason) return fixed;
    const disclosed = this.sanitizeMessage(String(error.message ?? ""));
    return disclosed.trim() ? disclosed : fixed;
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

    // The A2A spec §13.2 MUST NOT forbids revealing *the existence of a
    // resource*, not the *class* of failure. A fixed "Access denied" /
    // "Approval denied" / "Approval timed out" names no caller, target,
    // approver or rule, so it discloses nothing — a caller that named a skill
    // already held that id — while still telling an agent to stop rather than
    // retry.
    const refusal = GOVERNANCE_REFUSALS.get(errorCode);
    if (refusal !== undefined) {
      return { code: refusal.code, message: this.refusalMessage(refusal.message, error) };
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
 * including the governance refusals.
 *
 * The three governance codes (`ACL_DENIED`, `APPROVAL_DENIED`,
 * `APPROVAL_TIMEOUT`) are in this partition only when `discloseRefusalReason` is
 * set — the same flag the mapper branches on, so the two surfaces agree under
 * either setting.
 *
 * `errorMapper message policy matches toJsonRpcError` locks this to the
 * branching in `ErrorMapper.handleApcoreError` across every apcore error code
 * and both flag values, so the two cannot drift.
 */
export function carriesCallerDetail(error: unknown, discloseRefusalReason = false): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === ErrorCodes.MODULE_NOT_FOUND || code === ErrorCodes.GENERAL_INVALID_INPUT) {
    return true;
  }
  if (code === ErrorCodes.SCHEMA_VALIDATION_ERROR) {
    return !isServerSideSchemaError(String((error as { message?: string }).message ?? ""));
  }
  // The three governance codes move into and out of this partition with the
  // flag, so the task-status surface forwards exactly what the JSON-RPC surface
  // does under either setting (srs FR-ERR-011 criterion 4).
  if (isGovernanceRefusal(code)) {
    return discloseRefusalReason;
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
