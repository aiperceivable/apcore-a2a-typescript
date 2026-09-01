export class A2AClientError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class A2AConnectionError extends A2AClientError {}

export class A2ADiscoveryError extends A2AClientError {}

export class TaskNotFoundError extends A2AClientError {
  taskId?: string;
  constructor(taskId?: string) {
    super(taskId ? `Task not found: ${taskId}` : "Task not found");
    this.taskId = taskId;
  }
}

export class TaskNotCancelableError extends A2AClientError {
  state?: string;
  constructor(state?: string) {
    super(state ? `Task not cancelable: state=${state}` : "Task not cancelable");
    this.state = state;
  }
}

/**
 * Base class for the three governance refusals (srs FR-ERR-003 / 009 / 010).
 *
 * Distinguishing these from {@link A2AServerError} is the point of the typed
 * classes: a refusal is not a transient failure, and an agent that backs off and
 * retries one will be refused identically for as long as it keeps trying. Before
 * the server side of this change, an ACL denial arrived as
 * {@link TaskNotFoundError} and an approval denial as {@link A2AServerError} —
 * both naming a different failure than the one that happened.
 */
export class GovernanceRefusedError extends A2AClientError {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** JSON-RPC -32040: the ACL refused this caller. Terminal. */
export class AccessDeniedError extends GovernanceRefusedError {
  constructor(message = "Access denied") {
    super(message, -32040);
  }
}

/** JSON-RPC -32041: a human explicitly refused this call. Terminal. */
export class ApprovalDeniedError extends GovernanceRefusedError {
  constructor(message = "Approval denied") {
    super(message, -32041);
  }
}

/**
 * JSON-RPC -32042: the approval expired unanswered.
 *
 * Unlike the other two refusals, a fresh submission may legitimately be
 * approved — nobody refused, nobody answered.
 */
export class ApprovalTimeoutError extends GovernanceRefusedError {
  constructor(message = "Approval timed out") {
    super(message, -32042);
  }
}

export class A2AServerError extends A2AClientError {
  code: number;
  constructor(message: string, code: number = -32603) {
    super(message);
    this.code = code;
  }
}
