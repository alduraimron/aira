export interface ApprovalErrorOptions extends ErrorOptions {
  runId?: string;
  stepId?: string;
}

export class ApprovalError extends Error {
  readonly runId?: string;
  readonly stepId?: string;

  constructor(message: string, options: ApprovalErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ApprovalError";
    this.runId = options.runId;
    this.stepId = options.stepId;
  }
}
