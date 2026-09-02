import {
  getPendingRevision,
  isPendingRevisionResumeState,
} from "../run/revisions";
import type { RunState, StepState } from "../run/types";
import type { LoopStep, Workflow, WorkflowStep } from "../workflow/types";
import { ExecutionError } from "./errors";

export interface PreparedInterruptedRun {
  state: RunState;
  /** The interrupted loop iteration that must be replayed without incrementing it. */
  replayLoopId?: string;
}

export function prepareRunForResume(
  workflow: Workflow,
  state: RunState,
): PreparedInterruptedRun {
  if (state.status === "interrupted") {
    return prepareInterruptedRunForResume(workflow, state);
  }

  if (isPendingRevisionResumeState(state)) {
    return preparePendingRevisionForResume(workflow, state);
  }

  throw new ExecutionError(
    `run "${state.id}" must have status "interrupted" or a pending ` +
      `revision checkpoint before resume; found "${state.status}"`,
    { runId: state.id },
  );
}

/**
 * Converts a controlled interruption into an immutable, execution-ready state.
 * Persistence remains the caller's responsibility.
 */
export function prepareInterruptedRunForResume(
  workflow: Workflow,
  state: RunState,
): PreparedInterruptedRun {
  if (state.workflow !== workflow.name) {
    throw new ExecutionError(
      `run "${state.id}" was created for workflow "${state.workflow}" but ` +
        `resume received "${workflow.name}"`,
      { runId: state.id },
    );
  }

  if (state.status !== "interrupted") {
    throw new ExecutionError(
      `run "${state.id}" must have status "interrupted" before resume; ` +
        `found "${state.status}"`,
      { runId: state.id },
    );
  }

  const point = locateResumePoint(workflow, state);
  validateEarlierTopLevelSteps(workflow, state, point.index);
  const pointState = getStepState(state, point.step.id);

  if (pointState === undefined) {
    throw new ExecutionError(
      `resume step "${point.step.id}" is missing from run state`,
      { runId: state.id, stepId: point.step.id },
    );
  }

  if (point.step.uses === "loop") {
    return prepareLoopResume(state, point.step, pointState);
  }

  if (pointState.status !== "interrupted" && pointState.status !== "pending") {
    throw new ExecutionError(
      `resume step "${point.step.id}" must be interrupted or pending; ` +
        `found "${pointState.status}"`,
      { runId: state.id, stepId: point.step.id },
    );
  }

  const steps = { ...state.steps };

  if (pointState.status === "interrupted") {
    steps[point.step.id] = resetExecutionState(pointState);
  }

  return {
    state: {
      ...state,
      status: "running",
      current_step: point.step.id,
      steps,
    },
  };
}

function preparePendingRevisionForResume(
  workflow: Workflow,
  state: RunState,
): PreparedInterruptedRun {
  if (state.workflow !== workflow.name) {
    throw new ExecutionError(
      `run "${state.id}" was created for workflow "${state.workflow}" but ` +
        `resume received "${workflow.name}"`,
      { runId: state.id },
    );
  }

  const revision = getPendingRevision(state);

  if (revision === undefined) {
    throw new ExecutionError(
      `run "${state.id}" has no pending revision to resume`,
      { runId: state.id },
    );
  }

  const index = workflow.steps.findIndex(
    (step) => step.id === revision.target_step,
  );
  const step = workflow.steps[index];

  if (index < 0 || step?.uses !== "agent") {
    throw new ExecutionError(
      `pending revision target "${revision.target_step}" is not a ` +
        "top-level agent step",
      { runId: state.id, stepId: revision.target_step },
    );
  }

  validateEarlierTopLevelSteps(workflow, state, index);
  const stepState = getStepState(state, step.id);

  if (
    stepState === undefined ||
    (stepState.status !== "pending" && stepState.status !== "running")
  ) {
    throw new ExecutionError(
      `pending revision step "${step.id}" must be pending or running; ` +
        `found "${stepState?.status ?? "missing"}"`,
      { runId: state.id, stepId: step.id },
    );
  }

  return {
    state: {
      ...state,
      status: "running",
      current_step: step.id,
      steps:
        stepState.status === "running"
          ? {
              ...state.steps,
              [step.id]: resetExecutionState(stepState),
            }
          : state.steps,
    },
  };
}

interface LocatedResumePoint {
  step: WorkflowStep;
  index: number;
}

function locateResumePoint(
  workflow: Workflow,
  state: RunState,
): LocatedResumePoint {
  if (state.current_step !== undefined) {
    const topLevelIndex = workflow.steps.findIndex(
      (step) => step.id === state.current_step,
    );

    if (topLevelIndex >= 0) {
      const step = workflow.steps[topLevelIndex];

      if (step !== undefined) {
        return { step, index: topLevelIndex };
      }
    }

    for (const [index, step] of workflow.steps.entries()) {
      if (
        step.uses === "loop" &&
        step.steps.some((child) => child.id === state.current_step)
      ) {
        return { step, index };
      }
    }

    throw new ExecutionError(
      `run "${state.id}" current_step "${state.current_step}" is not in ` +
        `workflow "${workflow.name}"`,
      { runId: state.id, stepId: state.current_step },
    );
  }

  for (const [index, step] of workflow.steps.entries()) {
    const stepState = getStepState(state, step.id);

    if (stepState?.status === "interrupted") {
      return { step, index };
    }

    if (
      step.uses === "loop" &&
      step.steps.some(
        (child) => getStepState(state, child.id)?.status === "interrupted",
      )
    ) {
      return { step, index };
    }
  }

  for (const [index, step] of workflow.steps.entries()) {
    if (getStepState(state, step.id)?.status === "pending") {
      return { step, index };
    }
  }

  throw new ExecutionError(
    `run "${state.id}" has no interrupted or pending execution point to resume`,
    { runId: state.id },
  );
}

function validateEarlierTopLevelSteps(
  workflow: Workflow,
  state: RunState,
  resumeIndex: number,
): void {
  for (let index = 0; index < resumeIndex; index += 1) {
    const step = workflow.steps[index];

    if (step === undefined) {
      continue;
    }

    const status = getStepState(state, step.id)?.status;

    if (status !== "completed" && status !== "skipped") {
      throw new ExecutionError(
        `step "${step.id}" before resume point must be completed or skipped; ` +
          `found "${status ?? "missing"}"`,
        { runId: state.id, stepId: step.id },
      );
    }
  }
}

function prepareLoopResume(
  state: RunState,
  loop: LoopStep,
  loopState: StepState,
): PreparedInterruptedRun {
  if (loopState.status === "pending") {
    if (loopState.attempt >= loop.max_attempts) {
      throw new ExecutionError(
        `pending resume loop "${loop.id}" cannot start after attempt ` +
          `${loopState.attempt}; max_attempts is ${loop.max_attempts}`,
        { runId: state.id, stepId: loop.id },
      );
    }

    validatePendingLoopChildren(state, loop);
    return {
      state: {
        ...state,
        status: "running",
        current_step: loop.id,
      },
    };
  }

  if (loopState.status !== "interrupted") {
    throw new ExecutionError(
      `resume loop "${loop.id}" must be interrupted or pending; found ` +
        `"${loopState.status}"`,
      { runId: state.id, stepId: loop.id },
    );
  }

  if (loopState.attempt < 1 || loopState.attempt > loop.max_attempts) {
    throw new ExecutionError(
      `interrupted loop "${loop.id}" has invalid attempt ` +
        `${loopState.attempt}; max_attempts is ${loop.max_attempts}`,
      { runId: state.id, stepId: loop.id },
    );
  }

  const steps = { ...state.steps };
  steps[loop.id] = resetLoopState(loopState);

  for (const child of loop.steps) {
    const childState = getStepState(state, child.id);

    if (childState === undefined) {
      throw new ExecutionError(
        `child step "${child.id}" of loop "${loop.id}" is missing from ` +
          `run state during resume`,
        { runId: state.id, stepId: child.id },
      );
    }

    steps[child.id] = resetExecutionState(childState);
  }

  return {
    state: {
      ...state,
      status: "running",
      current_step: loop.id,
      steps,
    },
    replayLoopId: loop.id,
  };
}

function validatePendingLoopChildren(state: RunState, loop: LoopStep): void {
  for (const child of loop.steps) {
    const status = getStepState(state, child.id)?.status;

    if (status !== "pending") {
      throw new ExecutionError(
        `pending resume loop "${loop.id}" requires child "${child.id}" to ` +
          `be pending; found "${status ?? "missing"}"`,
        { runId: state.id, stepId: child.id },
      );
    }
  }
}

function resetExecutionState(state: StepState): StepState {
  return {
    status: "pending",
    attempt: state.attempt,
  };
}

function resetLoopState(state: StepState): StepState {
  return {
    status: "running",
    attempt: state.attempt,
    ...(state.started_at === undefined ? {} : { started_at: state.started_at }),
  };
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
