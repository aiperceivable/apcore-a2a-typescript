const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL_ERROR = -32603;
const CODE_TASK_NOT_FOUND = -32001;

export interface JsonRpcError {
  code: number;
  message: string;
}

export class ErrorMapper {
  toJsonRpcError(error: unknown): JsonRpcError {
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
    if (errorCode === "MODULE_NOT_FOUND") {
      const message = this.sanitizeMessage((error as { message: string }).message);
      return { code: CODE_METHOD_NOT_FOUND, message };
    }

    if (errorCode === "SCHEMA_VALIDATION_ERROR") {
      const message = this.sanitizeMessage((error as { message: string }).message);
      return { code: CODE_INVALID_PARAMS, message };
    }

    if (errorCode === "ACL_DENIED") {
      return { code: CODE_TASK_NOT_FOUND, message: "Task not found" };
    }

    if (errorCode === "MODULE_TIMEOUT" || errorCode === "EXECUTION_TIMEOUT") {
      return { code: CODE_INTERNAL_ERROR, message: "Execution timeout" };
    }

    if (
      errorCode === "CALL_DEPTH_EXCEEDED" ||
      errorCode === "CIRCULAR_CALL" ||
      errorCode === "CALL_FREQUENCY_EXCEEDED"
    ) {
      return { code: CODE_INTERNAL_ERROR, message: "Safety limit exceeded" };
    }

    if (errorCode === "INVALID_INPUT") {
      const description = this.sanitizeMessage((error as { message: string }).message);
      return { code: CODE_INVALID_PARAMS, message: `Invalid input: ${description}` };
    }

    return { code: CODE_INTERNAL_ERROR, message: "Internal server error" };
  }

  sanitizeMessage(message: string): string {
    return message.replace(/~?\/\S*/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
  }
}
