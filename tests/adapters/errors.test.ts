import { describe, it, expect } from "vitest";
import { ErrorCodes, ModuleError, SchemaValidationError } from "apcore-js";
import {
  ErrorMapper,
  carriesCallerDetail,
  isServerSideSchemaError,
} from "../../src/adapters/errors.js";

function createApcoreError(code: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("ErrorMapper", () => {
  const mapper = new ErrorMapper();

  describe("toJsonRpcError", () => {
    it("maps MODULE_NOT_FOUND to -32601", () => {
      const err = createApcoreError("MODULE_NOT_FOUND", "Module foo not found");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32601);
      expect(result.message).toContain("Module foo not found");
    });

    it("maps SCHEMA_VALIDATION_ERROR to -32602", () => {
      const err = createApcoreError("SCHEMA_VALIDATION_ERROR", "Field x is required");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32602);
      expect(result.message).toContain("Field x is required");
    });

    it("maps ACL_DENIED to -32001 with masked message", () => {
      const err = createApcoreError("ACL_DENIED", "User admin denied access to secret.module");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32001);
      expect(result.message).toBe("Task not found");
    });

    it("maps MODULE_TIMEOUT to -32603", () => {
      const err = createApcoreError("MODULE_TIMEOUT", "Timed out");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Execution timeout");
    });

    it("maps EXECUTION_CANCELLED to -32603", () => {
      const err = createApcoreError("EXECUTION_CANCELLED", "Cancelled");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Execution cancelled");
    });

    it("maps CALL_DEPTH_EXCEEDED to -32603 safety limit", () => {
      const err = createApcoreError("CALL_DEPTH_EXCEEDED", "Too deep");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Safety limit exceeded");
    });

    it("maps CIRCULAR_CALL to -32603 safety limit", () => {
      const err = createApcoreError("CIRCULAR_CALL", "Circular");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Safety limit exceeded");
    });

    it("maps CALL_FREQUENCY_EXCEEDED to -32603 safety limit", () => {
      const err = createApcoreError("CALL_FREQUENCY_EXCEEDED", "Too fast");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Safety limit exceeded");
    });

    it("maps GENERAL_INVALID_INPUT to -32602 with description", () => {
      const err = createApcoreError("GENERAL_INVALID_INPUT", "Missing field name");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32602);
      expect(result.message).toBe("Invalid input: Missing field name");
    });

    it("maps MODULE_DISABLED to -32603", () => {
      const err = createApcoreError("MODULE_DISABLED", "Module foo is disabled");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Module is currently disabled");
    });

    it("maps CONFIG_NAMESPACE_DUPLICATE to -32603", () => {
      const err = createApcoreError("CONFIG_NAMESPACE_DUPLICATE", "Namespace already registered");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Configuration error");
    });

    it("maps CONFIG_MOUNT_ERROR to -32603", () => {
      const err = createApcoreError("CONFIG_MOUNT_ERROR", "Mount failed");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Configuration error");
    });

    it("maps CONFIG_BIND_ERROR to -32603", () => {
      const err = createApcoreError("CONFIG_BIND_ERROR", "Bind failed");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Configuration error");
    });

    it("maps unknown apcore code to -32603", () => {
      const err = createApcoreError("UNKNOWN_ERROR", "Something");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Internal server error");
    });

    it("maps generic Error to -32603", () => {
      const result = mapper.toJsonRpcError(new Error("something broke"));
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Internal server error");
    });

    it("maps non-Error to -32603", () => {
      const result = mapper.toJsonRpcError("string error");
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Internal server error");
    });
  });

  describe("format", () => {
    it("delegates to toJsonRpcError", () => {
      const err = createApcoreError("MODULE_NOT_FOUND", "Module not found: foo");
      const result = mapper.format(err);
      expect(result).toEqual({ code: -32601, message: expect.stringContaining("Module not found") });
    });

    it("accepts optional context parameter", () => {
      const err = new Error("generic");
      const result = mapper.format(err, { some: "context" });
      expect(result).toEqual({ code: -32603, message: "Internal server error" });
    });
  });

  describe("message sanitization (via toJsonRpcError)", () => {
    it("strips Unix absolute paths from error messages", () => {
      const err = createApcoreError("MODULE_NOT_FOUND", "Error at /home/user/file.py here");
      const result = mapper.toJsonRpcError(err);
      expect(result.message).toBe("Error at here");
    });

    it("strips traceback lines (Traceback, File, line N) from error messages", () => {
      const err = createApcoreError(
        "MODULE_NOT_FOUND",
        'Field x is required\nTraceback (most recent call last):\n  File "/a/b.py", line 5, in foo\n    raise X',
      );
      const result = mapper.toJsonRpcError(err);
      expect(result.message).not.toContain("Traceback");
      expect(result.message).not.toContain("File");
      expect(result.message).not.toContain("line 5");
      expect(result.message).toContain("Field x is required");
    });

    it("strips tilde paths from error messages", () => {
      const err = createApcoreError("MODULE_NOT_FOUND", "Error at ~/project/file.ts");
      const result = mapper.toJsonRpcError(err);
      expect(result.message).toBe("Error at");
    });

    it("truncates long messages to 500 characters", () => {
      const long = "x".repeat(600);
      const err = createApcoreError("MODULE_NOT_FOUND", long);
      const result = mapper.toJsonRpcError(err);
      expect(result.message).toHaveLength(500);
    });

    it("preserves clean messages", () => {
      const err = createApcoreError("MODULE_NOT_FOUND", "Field 'name' is required");
      const result = mapper.toJsonRpcError(err);
      expect(result.message).toBe("Field 'name' is required");
    });
  });
});

// ---------------------------------------------------------------------------
// Message-widening policy (apexe #33)
// ---------------------------------------------------------------------------

describe("message-widening policy", () => {
  const mapper = new ErrorMapper();

  it("errorMapper message policy matches toJsonRpcError", () => {
    // carriesCallerDetail is what gates message widening (see failureText in
    // server/executor.ts), so it must name exactly the codes whose own message
    // toJsonRpcError actually forwards. Asserted over every apcore error code
    // with a sentinel that survives sanitization, so adding a code or a branch
    // cannot silently desync the two.
    const sentinel = "canary-2f8a";
    const codes = Object.values(ErrorCodes).filter((v): v is string => typeof v === "string");
    expect(codes.length).toBeGreaterThan(50);

    for (const code of codes) {
      const err = new ModuleError(code, sentinel);
      const forwarded = mapper.toJsonRpcError(err).message.includes(sentinel);
      expect(
        forwarded,
        `${code}: toJsonRpcError forwards the message = ${forwarded}, ` +
          `carriesCallerDetail = ${carriesCallerDetail(err)}`,
      ).toBe(carriesCallerDetail(err));
    }

    // The one code whose policy is not decided by the code alone.
    for (const message of ["Output validation failed", "Output validation failed: width"]) {
      const err = new ModuleError(ErrorCodes.SCHEMA_VALIDATION_ERROR, message);
      expect(carriesCallerDetail(err), message).toBe(false);
      expect(mapper.toJsonRpcError(err).message, message).toBe("Internal server error");
    }
  });

  it("does not report an output-validation failure as caller-fixable", () => {
    // apcore raises SCHEMA_VALIDATION_ERROR for output validation too
    // (builtin-steps: validateSchema(outputSchema, output, "Output")), so a
    // module returning the wrong shape reached the caller as -32602 Invalid
    // params -- telling them to fix a correct request, with apcore's default
    // guidance claiming "Input validation failed" and pointing at a details
    // field an A2A caller never receives.
    const err = new SchemaValidationError("Output validation failed");
    const result = mapper.toJsonRpcError(err);
    expect(result.code).toBe(-32603);
    expect(result.message).toBe("Internal server error");

    // Input validation -- the caller-fixable direction -- is untouched, and so
    // is a module raising the code with its own wording.
    for (const message of ["Input validation failed", "width: must be integer"]) {
      const out = mapper.toJsonRpcError(
        new ModuleError(ErrorCodes.SCHEMA_VALIDATION_ERROR, message),
      );
      expect(out.code, message).toBe(-32602);
      expect(out.message, message).toBe(message);
    }
  });

  it("recognizes only the output direction as server-side", () => {
    expect(isServerSideSchemaError("Output validation failed")).toBe(true);
    expect(isServerSideSchemaError("Input validation failed")).toBe(false);
    // apcore-js raises ConfigError / CONFIG_INVALID for config validation,
    // which the mapper catch-all already masks, so no "Config" label reaches
    // this function.
    expect(isServerSideSchemaError("Configuration validation failed (1 error(s)):")).toBe(false);
    expect(isServerSideSchemaError("width: must be integer")).toBe(false);
  });
});
