export interface RunStateErrorOptions extends ErrorOptions {
  runId?: string;
  filePath?: string;
}

export class RunStateError extends Error {
  readonly runId?: string;
  readonly filePath?: string;

  constructor(message: string, options: RunStateErrorOptions = {}) {
    const context: string[] = [];

    if (options.runId !== undefined) {
      context.push(`run "${options.runId}"`);
    }

    if (options.filePath !== undefined) {
      context.push(`path "${options.filePath}"`);
    }

    super(
      context.length > 0 ? `${message} (${context.join(", ")})` : message,
      { cause: options.cause },
    );
    this.name = "RunStateError";
    this.runId = options.runId;
    this.filePath = options.filePath;
  }
}
