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
    // Strip file paths (Unix absolute paths and ~ paths)
    let sanitized = message.replace(/~?\/\S*/g, "");
    // Strip traceback lines (matching Python's behavior)
    sanitized = sanitized.replace(/^.*(?:Traceback|File "|line \d+).*$/gm, "");
    return sanitized.replace(/\s+/g, " ").trim().slice(0, 500);
  }
}
