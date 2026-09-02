import type { RevisionRecord, RunState } from "./types";

export function getPendingRevision(
  state: RunState,
): RevisionRecord | undefined {
  const revisions = state.revisions;

  if (revisions === undefined) {
    return undefined;
  }

  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];

    if (revision?.status === "pending") {
      return revision;
    }
  }

  return undefined;
}

export function resolveRevisionForStep(
  state: RunState,
  stepId: string,
  resolvedAt: Date,
): RunState {
  const pending = getPendingRevision(state);

  if (pending === undefined || pending.target_step !== stepId) {
    return state;
  }

  const revisions = state.revisions;

  if (revisions === undefined) {
    return state;
  }

  return {
    ...state,
    revisions: revisions.map((revision) =>
      revision === pending
        ? {
            ...revision,
            status: "resolved" as const,
            resolved_at: resolvedAt.toISOString(),
          }
        : revision,
    ),
  };
}

export function isPendingRevisionResumeState(state: RunState): boolean {
  if (state.status !== "running" || state.current_step === undefined) {
    return false;
  }

  const revision = getPendingRevision(state);

  if (
    revision === undefined ||
    revision.target_step !== state.current_step
  ) {
    return false;
  }

  const step = Object.prototype.hasOwnProperty.call(
    state.steps,
    revision.target_step,
  )
    ? state.steps[revision.target_step]
    : undefined;

  return step?.status === "pending" || step?.status === "running";
}
