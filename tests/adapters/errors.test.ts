import { describe, it, expect } from "vitest";
import { ErrorMapper } from "../../src/adapters/errors.js";

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

    it("maps EXECUTION_TIMEOUT to -32603", () => {
      const err = createApcoreError("EXECUTION_TIMEOUT", "Timed out");
      const result = mapper.toJsonRpcError(err);
      expect(result.code).toBe(-32603);
      expect(result.message).toBe("Execution timeout");
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

    it("maps INVALID_INPUT to -32602 with description", () => {
      const err = createApcoreError("INVALID_INPUT", "Missing field name");
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
      const err = createApcoreError("MODULE_NOT_FOUND", "Error at /home/user/file.py line 10");
      const result = mapper.toJsonRpcError(err);
      expect(result.message).toBe("Error at line 10");
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
