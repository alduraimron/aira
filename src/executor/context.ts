import type { AiraConfig } from "../config/types";
import type { TemplateContext } from "../context/types";
import { getPendingRevision } from "../run/revisions";
import type { RunState } from "../run/types";

export interface ExecutionContextInput {
  config: AiraConfig;
  artifacts?: Record<string, unknown>;
}

export interface RevisionContext {
  targetStep: string;
  requestedAt: string;
  feedback: string;
  previousArtifact?: string;
  previousArtifactName?: string;
  previousArtifactPath?: string;
}

export interface ResolvedExecutionContext extends ExecutionContextInput {
  revision?: RevisionContext;
}

const EMPTY_REVISION_CONTEXT = {
  active: false,
  feedback: "",
  previous_artifact: "",
  previous_artifact_name: "",
  previous_artifact_path: "",
} as const;

export function createExecutionTemplateContext(
  state: RunState,
  context: ResolvedExecutionContext,
): TemplateContext {
  const pending = getPendingRevision(state);
  const revision = context.revision;
  const revisionApplies =
    pending !== undefined &&
    revision !== undefined &&
    state.current_step === pending.target_step &&
    revision.targetStep === pending.target_step &&
    revision.requestedAt === pending.requested_at;

  return {
    input: state.input,
    config: { ...context.config },
    artifacts: context.artifacts ?? {},
    revision: revisionApplies
      ? {
          active: true,
          feedback: revision.feedback,
          previous_artifact: revision.previousArtifact ?? "",
          previous_artifact_name: revision.previousArtifactName ?? "",
          previous_artifact_path: revision.previousArtifactPath ?? "",
        }
      : EMPTY_REVISION_CONTEXT,
    steps: state.steps,
    run: {
      id: state.id,
      workflow: state.workflow,
      status: state.status,
    },
  };
}
