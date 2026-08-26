export interface ExecutionErrorOptions extends ErrorOptions {
  runId?: string;
  stepId?: string;
}

export class ExecutionError extends Error {
  readonly runId?: string;
  readonly stepId?: string;

  constructor(message: string, options: ExecutionErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ExecutionError";
    this.runId = options.runId;
    this.stepId = options.stepId;
  }
}
