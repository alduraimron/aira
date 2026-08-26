import { RunStateError } from "./errors";
import { runStatusSchema, stepStateSchema } from "./schema";
import type {
  RunState,
  RunStatus,
  StepState,
} from "./types";

export function initializeStepStates(
  stepIds: readonly string[],
): Record<string, StepState> {
  const entries: Array<[string, StepState]> = [];
  const seen = new Set<string>();

  for (const stepId of stepIds) {
    if (typeof stepId !== "string" || stepId.length === 0) {
      throw new RunStateError("Initial step IDs must be non-empty strings");
    }

    if (seen.has(stepId)) {
      throw new RunStateError(`Duplicate initial step ID "${stepId}"`);
    }

    seen.add(stepId);
    entries.push([stepId, { status: "pending", attempt: 0 }]);
  }

  return Object.fromEntries(entries);
}

export function setRunStatus(
  state: RunState,
  status: RunStatus,
): RunState {
  const result = runStatusSchema.safeParse(status);

  if (!result.success) {
    throw new RunStateError(`Invalid run status "${String(status)}"`, {
      runId: state.id,
      cause: result.error,
    });
  }

  return {
    ...state,
    status: result.data,
  };
}

export function patchStepState(
  state: RunState,
  stepId: string,
  patch: Partial<StepState>,
): RunState {
  if (!Object.prototype.hasOwnProperty.call(state.steps, stepId)) {
    throw new RunStateError(`Cannot patch unknown step "${stepId}"`, {
      runId: state.id,
    });
  }

  const current = state.steps[stepId];

  if (current === undefined) {
    throw new RunStateError(`Cannot patch unknown step "${stepId}"`, {
      runId: state.id,
    });
  }

  const result = stepStateSchema.safeParse({
    ...current,
    ...patch,
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new RunStateError(
      `Invalid state patch for step "${stepId}": ${details}`,
      { runId: state.id, cause: result.error },
    );
  }

  return {
    ...state,
    steps: {
      ...state.steps,
      [stepId]: result.data,
    },
  };
}
