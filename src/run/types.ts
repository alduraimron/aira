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
}
