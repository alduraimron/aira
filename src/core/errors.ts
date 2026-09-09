export type AiraCoreErrorCode =
  | "project-not-initialized"
  | "workflow-not-found"
  | "run-not-found"
  | "invalid-run-input"
  | "stale-preparation"
  | "stale-boundary"
  | "dirty-worktree"
  | "invalid-lifecycle-action"
  | "invalid-revision-feedback"
  | "incompatible-run-state"
  | "missing-runtime-dependency"
  | "execution-failed";

export interface AiraCoreErrorOptions extends ErrorOptions {
  operation: string;
  runId?: string;
  workflow?: string;
  stepId?: string;
}

export class AiraCoreError extends Error {
  readonly code: AiraCoreErrorCode;
  readonly operation: string;
  readonly runId?: string;
  readonly workflow?: string;
  readonly stepId?: string;

  constructor(
    code: AiraCoreErrorCode,
    message: string,
    options: AiraCoreErrorOptions,
  ) {
    super(message, { cause: options.cause });
    this.name = "AiraCoreError";
    this.code = code;
    this.operation = options.operation;
    this.runId = options.runId;
    this.workflow = options.workflow;
    this.stepId = options.stepId;
  }
}

export class ProjectNotInitializedError extends AiraCoreError {
  readonly startDirectory: string;

  constructor(root: string, operation: string) {
    super(
      "project-not-initialized",
      'no .aira project found; run "aira init"',
      { operation },
    );
    this.name = "ProjectNotInitializedError";
    this.startDirectory = root;
  }
}

export class CoreWorkflowNotFoundError extends AiraCoreError {
  constructor(workflow: string, operation: string, cause?: unknown) {
    super(
      "workflow-not-found",
      `workflow "${workflow}" not found`,
      { operation, workflow, cause },
    );
    this.name = "CoreWorkflowNotFoundError";
  }
}

export class CoreRunNotFoundError extends AiraCoreError {
  constructor(runId: string, operation: string, cause?: unknown) {
    super(
      "run-not-found",
      `run "${runId}" was not found`,
      { operation, runId, cause },
    );
    this.name = "CoreRunNotFoundError";
  }
}

export class InvalidRunInputError extends AiraCoreError {
  constructor(message: string, operation: string, workflow?: string) {
    super("invalid-run-input", message, { operation, workflow });
    this.name = "InvalidRunInputError";
  }
}

export class StaleRunPreparationError extends AiraCoreError {
  constructor(workflow: string) {
    super(
      "stale-preparation",
      `workflow "${workflow}" or its configuration changed after preview; inspect and authorize it again`,
      { operation: "startRun", workflow },
    );
    this.name = "StaleRunPreparationError";
  }
}

export class StaleRunBoundaryError extends AiraCoreError {
  constructor(runId: string) {
    super(
      "stale-boundary",
      `run "${runId}" changed after inspection; inspect it and authorize the action again`,
      { operation: "continueRun", runId },
    );
    this.name = "StaleRunBoundaryError";
  }
}

export class DirtyWorktreeError extends AiraCoreError {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      "dirty-worktree",
      "working tree is dirty; commit/stash changes or use --allow-dirty",
      { operation: "startRun" },
    );
    this.name = "DirtyWorktreeError";
    this.projectRoot = projectRoot;
  }
}

export class InvalidLifecycleActionError extends AiraCoreError {
  readonly action: string;
  readonly allowedActions: readonly string[];

  constructor(params: {
    runId: string;
    action: string;
    message: string;
    allowedActions?: readonly string[];
    stepId?: string;
    cause?: unknown;
  }) {
    super("invalid-lifecycle-action", params.message, {
      operation: "continueRun",
      runId: params.runId,
      stepId: params.stepId,
      cause: params.cause,
    });
    this.name = "InvalidLifecycleActionError";
    this.action = params.action;
    this.allowedActions = params.allowedActions ?? [];
  }
}

export class InvalidRevisionFeedbackError extends AiraCoreError {
  constructor(runId: string) {
    super(
      "invalid-revision-feedback",
      "revision feedback must not be empty",
      { operation: "continueRun", runId },
    );
    this.name = "InvalidRevisionFeedbackError";
  }
}

export class IncompatibleRunStateError extends AiraCoreError {
  constructor(params: {
    operation: string;
    runId: string;
    message: string;
    workflow?: string;
    stepId?: string;
    cause?: unknown;
  }) {
    super("incompatible-run-state", params.message, params);
    this.name = "IncompatibleRunStateError";
  }
}

export class MissingRuntimeDependencyError extends AiraCoreError {
  constructor(workflow: string, operation: string) {
    super(
      "missing-runtime-dependency",
      `workflow "${workflow}" contains agent steps but no AgentRuntime factory was configured`,
      { operation, workflow },
    );
    this.name = "MissingRuntimeDependencyError";
  }
}

export class CoreExecutionError extends AiraCoreError {
  readonly persisted: boolean;

  constructor(params: {
    runId: string;
    message: string;
    stepId?: string;
    cause: unknown;
    persisted: boolean;
  }) {
    super("execution-failed", params.message, {
      operation: "execute",
      runId: params.runId,
      stepId: params.stepId,
      cause: params.cause,
    });
    this.name = "CoreExecutionError";
    this.persisted = params.persisted;
  }
}
