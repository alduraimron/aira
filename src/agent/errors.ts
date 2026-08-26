export type AgentRuntimeErrorKind =
  | "invalid-request"
  | "model-runtime"
  | "model-resolution"
  | "session-creation"
  | "session-execution"
  | "session-log"
  | "session-cleanup";

export interface AgentRuntimeErrorOptions extends ErrorOptions {
  kind: AgentRuntimeErrorKind;
  stepId: string;
}

export class AgentRuntimeError extends Error {
  readonly kind: AgentRuntimeErrorKind;
  readonly stepId: string;

  constructor(message: string, options: AgentRuntimeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AgentRuntimeError";
    this.kind = options.kind;
    this.stepId = options.stepId;
  }
}
