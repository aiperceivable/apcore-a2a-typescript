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

export class A2AServerError extends A2AClientError {
  code: number;
  constructor(message: string, code: number = -32603) {
    super(message);
    this.code = code;
  }
}
