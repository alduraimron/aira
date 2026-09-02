export const RUN_STATUSES = [
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "interrupted",
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export interface StepState {
  status: StepStatus;
  attempt: number;
  started_at?: string;
  completed_at?: string;
  success?: boolean;
  exit_code?: number;
  summary?: string;
  result?: string;
  artifact?: string;
  output?: string;
}

export interface ArtifactState {
  current: string;
  versions?: string[];
}

export const REVISION_STATUSES = ["pending", "resolved"] as const;

export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export interface RevisionArtifactReference {
  name: string;
  path: string;
}

export interface RevisionRecord {
  approval_step: string;
  target_step: string;
  feedback: string;
  requested_at: string;
  status: RevisionStatus;
  previous_artifact?: RevisionArtifactReference;
  resolved_at?: string;
}

export interface RunState {
  version: 1;
  id: string;
  workflow: string;
  status: RunStatus;
  input: Record<string, unknown>;
  current_step?: string;
  started_at: string;
  updated_at: string;
  steps: Record<string, StepState>;
  artifacts: Record<string, ArtifactState>;
  revisions?: RevisionRecord[];
}
