import { saveRun } from "../run/persistence";
import { getPendingRevision } from "../run/revisions";
import type {
  RevisionArtifactReference,
  RevisionRecord,
  RunState,
  StepState,
} from "../run/types";
import type {
  ApprovalStep,
  Workflow,
  WorkflowStep,
} from "../workflow/types";
import { ApprovalError } from "./errors";
import {
  APPROVAL_DECISIONS,
  type ApplyApprovalDecisionParams,
  type ApprovalDecision,
} from "./types";

interface LocatedWorkflowStep {
  step: WorkflowStep;
  topLevelIndex: number;
  parentLoopId?: string;
}

interface ApprovalPreconditions {
  approval: ApprovalStep;
  approvalIndex: number;
  approvalState: StepState;
}

interface RevisionRange {
  targetStepId: string;
  targetIndex: number;
}

const decisionSet = new Set<string>(APPROVAL_DECISIONS);
const systemClock = () => new Date();

export async function applyApprovalDecision(
  params: ApplyApprovalDecisionParams,
): Promise<RunState> {
  if (!decisionSet.has(params.decision)) {
    throw new ApprovalError(
      `unsupported approval decision "${String(params.decision)}"`,
      { runId: params.state.id, stepId: params.stepId },
    );
  }

  const preconditions = checkPreconditions(params);
  const revisionRange =
    params.decision === "revise"
      ? getRevisionRange(
          params.workflow,
          preconditions.approval,
          preconditions.approvalIndex,
          params.state,
        )
      : undefined;
  const revisionFeedback =
    params.decision === "revise"
      ? normalizeRevisionFeedback(
          params.feedback,
          params.state.id,
          params.stepId,
        )
      : undefined;
  const decidedAt = readClock(
    params.now ?? systemClock,
    params.state.id,
    params.stepId,
  );
  let nextState: RunState;

  switch (params.decision) {
    case "approve":
      nextState = applyApprove(
        params.state,
        params.stepId,
        preconditions.approvalState,
        decidedAt,
      );
      break;
    case "cancel":
      nextState = applyCancel(
        params.state,
        params.stepId,
        preconditions.approvalState,
        decidedAt,
      );
      break;
    case "revise":
      if (revisionRange === undefined) {
        throw new ApprovalError(
          `approval step "${params.stepId}" has no revision range`,
          { runId: params.state.id, stepId: params.stepId },
        );
      }

      if (revisionFeedback === undefined) {
        throw new ApprovalError("revision feedback is missing", {
          runId: params.state.id,
          stepId: params.stepId,
        });
      }

      nextState = applyRevise(
        params.workflow,
        params.state,
        preconditions.approval,
        preconditions.approvalIndex,
        revisionRange,
        revisionFeedback,
        decidedAt,
      );
      break;
  }

  try {
    await saveRun(params.runsRoot, nextState, decidedAt);
  } catch (cause) {
    throw new ApprovalError(
      `could not persist approval decision "${params.decision}" for ` +
        `step "${params.stepId}": ${getErrorMessage(cause)}`,
      { runId: params.state.id, stepId: params.stepId, cause },
    );
  }

  return nextState;
}

function checkPreconditions(
  params: ApplyApprovalDecisionParams,
): ApprovalPreconditions {
  const { state, workflow, stepId } = params;

  if (state.status !== "waiting") {
    throw new ApprovalError(
      `run "${state.id}" is not waiting for approval`,
      { runId: state.id, stepId },
    );
  }

  if (state.workflow !== workflow.name) {
    throw new ApprovalError(
      `run "${state.id}" was created for workflow "${state.workflow}" but ` +
        `approval decision received "${workflow.name}"`,
      { runId: state.id, stepId },
    );
  }

  if (state.current_step !== stepId) {
    throw new ApprovalError(
      `step "${stepId}" is not the current waiting approval`,
      { runId: state.id, stepId },
    );
  }

  const located = findWorkflowStep(workflow, stepId);

  if (located === undefined) {
    throw new ApprovalError(
      `workflow "${workflow.name}" does not contain step "${stepId}"`,
      { runId: state.id, stepId },
    );
  }

  if (located.step.uses !== "approval") {
    throw new ApprovalError(`step "${stepId}" is not an approval step`, {
      runId: state.id,
      stepId,
    });
  }

  if (located.parentLoopId !== undefined) {
    throw new ApprovalError(
      `approval step "${stepId}" is nested in loop ` +
        `"${located.parentLoopId}"; nested/loop approval runtime is not ` +
        "supported yet",
      { runId: state.id, stepId },
    );
  }

  const approvalState = getStepState(state, stepId);

  if (approvalState?.status !== "waiting") {
    throw new ApprovalError(
      `approval step "${stepId}" does not have persisted status "waiting"`,
      { runId: state.id, stepId },
    );
  }

  return {
    approval: located.step,
    approvalIndex: located.topLevelIndex,
    approvalState,
  };
}

function getRevisionRange(
  workflow: Workflow,
  approval: ApprovalStep,
  approvalIndex: number,
  state: RunState,
): RevisionRange {
  if (approval.revise === undefined) {
    throw new ApprovalError(
      `approval step "${approval.id}" does not support revision`,
      { runId: state.id, stepId: approval.id },
    );
  }

  const targetIndex = workflow.steps.findIndex(
    (step) => step.id === approval.revise,
  );
  const target = workflow.steps[targetIndex];

  if (
    targetIndex < 0 ||
    targetIndex >= approvalIndex ||
    target?.uses !== "agent"
  ) {
    throw new ApprovalError(
      `approval step "${approval.id}" has invalid revision target ` +
        `"${approval.revise}"`,
      { runId: state.id, stepId: approval.id },
    );
  }

  for (let index = targetIndex; index <= approvalIndex; index += 1) {
    const step = workflow.steps[index];

    if (step === undefined || getStepState(state, step.id) === undefined) {
      throw new ApprovalError(
        `step "${step?.id ?? approval.id}" in the revision replay range ` +
          "is missing from run state",
        { runId: state.id, stepId: approval.id },
      );
    }
  }

  return {
    targetStepId: approval.revise,
    targetIndex,
  };
}

function applyApprove(
  state: RunState,
  stepId: string,
  approvalState: StepState,
  decidedAt: Date,
): RunState {
  const { current_step: _currentStep, ...stateWithoutCurrentStep } = state;

  return {
    ...stateWithoutCurrentStep,
    status: "running",
    steps: {
      ...state.steps,
      [stepId]: {
        ...approvalState,
        status: "completed",
        success: true,
        completed_at: decidedAt.toISOString(),
        result: "approved",
      },
    },
  };
}

function applyCancel(
  state: RunState,
  stepId: string,
  approvalState: StepState,
  decidedAt: Date,
): RunState {
  const { current_step: _currentStep, ...stateWithoutCurrentStep } = state;

  return {
    ...stateWithoutCurrentStep,
    status: "cancelled",
    steps: {
      ...state.steps,
      [stepId]: {
        ...approvalState,
        status: "completed",
        success: false,
        completed_at: decidedAt.toISOString(),
        result: "cancelled",
      },
    },
  };
}

function applyRevise(
  workflow: Workflow,
  state: RunState,
  approval: ApprovalStep,
  approvalIndex: number,
  revisionRange: RevisionRange,
  feedback: string,
  requestedAt: Date,
): RunState {
  const pendingRevision = getPendingRevision(state);

  if (pendingRevision !== undefined) {
    throw new ApprovalError(
      `run "${state.id}" already has a pending revision for step ` +
        `"${pendingRevision.target_step}"`,
      { runId: state.id, stepId: approval.id },
    );
  }

  const steps = { ...state.steps };

  for (
    let index = revisionRange.targetIndex;
    index < approvalIndex;
    index += 1
  ) {
    const step = workflow.steps[index];

    if (step === undefined) {
      throw new ApprovalError("revision replay range is invalid", {
        runId: state.id,
        stepId: state.current_step,
      });
    }

    const stepState = getStepState(state, step.id);

    if (stepState === undefined) {
      throw new ApprovalError(
        `step "${step.id}" in the revision replay range is missing from run state`,
        { runId: state.id, stepId: state.current_step },
      );
    }

    steps[step.id] = resetExecutionStep(stepState);
  }

  const approvalStep = workflow.steps[approvalIndex];
  const approvalState =
    approvalStep === undefined
      ? undefined
      : getStepState(state, approvalStep.id);

  if (approvalStep === undefined || approvalState === undefined) {
    throw new ApprovalError("approval replay state is missing", {
      runId: state.id,
      stepId: state.current_step,
    });
  }

  steps[approvalStep.id] = resetApprovalStep(approvalState);

  const revision: RevisionRecord = {
    approval_step: approval.id,
    target_step: revisionRange.targetStepId,
    feedback,
    requested_at: requestedAt.toISOString(),
    status: "pending",
    ...getPreviousArtifactReference(state, approval),
  };

  return {
    ...state,
    status: "running",
    current_step: revisionRange.targetStepId,
    steps,
    revisions: [...(state.revisions ?? []), revision],
  };
}

function getPreviousArtifactReference(
  state: RunState,
  approval: ApprovalStep,
): { previous_artifact?: RevisionArtifactReference } {
  const name = approval.artifact;

  if (
    name === undefined ||
    !Object.prototype.hasOwnProperty.call(state.artifacts, name)
  ) {
    return {};
  }

  const artifact = state.artifacts[name];

  return artifact === undefined
    ? {}
    : { previous_artifact: { name, path: artifact.current } };
}

function normalizeRevisionFeedback(
  feedback: string | undefined,
  runId: string,
  stepId: string,
): string {
  const normalized = typeof feedback === "string" ? feedback.trim() : "";

  if (normalized.length === 0) {
    throw new ApprovalError("revision feedback must not be empty", {
      runId,
      stepId,
    });
  }

  return normalized;
}

function resetExecutionStep(stepState: StepState): StepState {
  const reset: StepState = {
    ...stepState,
    status: "pending",
  };

  delete reset.started_at;
  delete reset.completed_at;
  delete reset.success;
  delete reset.exit_code;
  delete reset.summary;
  delete reset.result;
  delete reset.artifact;
  delete reset.output;
  return reset;
}

function resetApprovalStep(stepState: StepState): StepState {
  const reset: StepState = {
    ...stepState,
    status: "pending",
  };

  delete reset.completed_at;
  delete reset.success;
  delete reset.result;
  delete reset.output;
  delete reset.summary;
  return reset;
}

function findWorkflowStep(
  workflow: Workflow,
  stepId: string,
): LocatedWorkflowStep | undefined {
  for (const [index, step] of workflow.steps.entries()) {
    if (step.id === stepId) {
      return { step, topLevelIndex: index };
    }
  }

  for (const [index, step] of workflow.steps.entries()) {
    if (step.uses !== "loop") {
      continue;
    }

    const nested = findNestedStep(step.steps, stepId, step.id, index);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function findNestedStep(
  steps: readonly WorkflowStep[],
  stepId: string,
  parentLoopId: string,
  topLevelIndex: number,
): LocatedWorkflowStep | undefined {
  for (const step of steps) {
    if (step.id === stepId) {
      return { step, topLevelIndex, parentLoopId };
    }

    if (step.uses === "loop") {
      const nested = findNestedStep(
        step.steps,
        stepId,
        step.id,
        topLevelIndex,
      );

      if (nested !== undefined) {
        return nested;
      }
    }
  }

  return undefined;
}

function getStepState(
  state: RunState,
  stepId: string,
): StepState | undefined {
  if (!Object.prototype.hasOwnProperty.call(state.steps, stepId)) {
    return undefined;
  }

  return state.steps[stepId];
}

function readClock(
  clock: () => Date,
  runId: string,
  stepId: string,
): Date {
  let value: Date;

  try {
    value = clock();
  } catch (cause) {
    throw new ApprovalError(`approval clock failed: ${getErrorMessage(cause)}`, {
      runId,
      stepId,
      cause,
    });
  }

  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ApprovalError("approval clock must return a valid Date", {
      runId,
      stepId,
    });
  }

  return value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
