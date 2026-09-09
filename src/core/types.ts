import type { AiraExecutionEvent } from "../executor";
import type { RunStatus, StepStatus } from "../run";

export interface CoreExecutionOptions {
  signal?: AbortSignal;
  onEvent?: (event: AiraExecutionEvent) => void;
}

export type ProjectInfo =
  | {
      initialized: false;
      root: string;
    }
  | {
      initialized: true;
      root: string;
      airaDirectory: string;
      created?: boolean;
    };

export interface WorkflowInfo {
  name: string;
  description?: string;
  stepCount: number;
  topLevelStepCount: number;
  hasAgentSteps: boolean;
}

export interface PreviewAgentConfiguration {
  model?: string;
  thinking?: string;
  timeoutSeconds: number;
  technicalRetries: number;
  tools: string[];
}

export interface RunPreviewArtifact {
  name: string;
  filename: string;
  versioned: boolean;
}

export interface RunPreviewStep {
  id: string;
  type: "agent" | "shell" | "approval" | "loop";
  parentStepId?: string;
  command?: string;
  artifact?: RunPreviewArtifact;
  approvalArtifact?: string;
  approvalMessage?: string;
  revisionTargetStepId?: string;
  maxAttempts?: number;
  agent?: PreviewAgentConfiguration;
  steps?: RunPreviewStep[];
}

export interface PreviewRunInput {
  workflow: string;
  task: string;
}

export interface RunPreview {
  projectRoot: string;
  preparationToken: string;
  workflow: WorkflowInfo;
  task: string;
  steps: RunPreviewStep[];
  hasAgentSteps: boolean;
}

export interface StartRunInput {
  workflow: string;
  task: string;
  allowDirty?: boolean;
  /** Refuses the run if files changed after a prior preview. */
  expectedPreparationToken?: string;
}

interface ContinueRunBase {
  runId: string;
  /** Refuses mutation if the inspected lifecycle state changed. */
  expectedBoundaryToken?: string;
}

export type ContinueRunInput =
  | (ContinueRunBase & { action: "approve" })
  | (ContinueRunBase & { action: "revise"; feedback: string })
  | (ContinueRunBase & { action: "cancel" })
  | (ContinueRunBase & { action: "resume" });

export type RunAction = "approve" | "revise" | "cancel" | "resume";

export type RunStepType = "agent" | "shell" | "approval" | "loop" | "unknown";

export interface RunStepView {
  id: string;
  type: RunStepType;
  status: StepStatus;
  attempt: number;
  parentStepId?: string;
  startedAt?: string;
  completedAt?: string;
  success?: boolean;
  summary?: string;
  artifactPath?: string;
}

export interface ArtifactVersionMetadata {
  path: string;
  isCurrent: boolean;
  version?: number;
}

export interface ArtifactMetadata {
  name: string;
  currentPath: string;
  versioned: boolean;
  versionCount: number;
  versions: ArtifactVersionMetadata[];
  producerStepId?: string;
}

export interface BoundaryStep {
  id: string;
  type: RunStepType;
  status: StepStatus;
  attempt: number;
}

interface RunBoundaryBase {
  runId: string;
  workflow: string;
  checkpointToken: string;
  status: RunStatus;
  summary: string;
  currentStep?: BoundaryStep;
  allowedActions: RunAction[];
  artifacts: ArtifactMetadata[];
}

export interface CompletedBoundary extends RunBoundaryBase {
  kind: "completed";
  status: "completed";
}

export type ApprovalArtifactView =
  | {
      name: string;
      available: false;
      reason?: string;
    }
  | (ArtifactMetadata & {
      available: true;
      content: string;
    });

export interface ApprovalRequiredBoundary extends RunBoundaryBase {
  kind: "approval-required";
  status: "waiting";
  approval: {
    stepId: string;
    message: string;
    artifact?: ApprovalArtifactView;
    revisionTargetStepId?: string;
    allowedDecisions: Array<"approve" | "revise" | "cancel">;
  };
}

export interface InterruptedBoundary extends RunBoundaryBase {
  kind: "interrupted";
  status: "interrupted";
  resumable: boolean;
  resumeReason?: string;
}

export interface FailedBoundary extends RunBoundaryBase {
  kind: "failed";
  status: "failed";
  failure?: {
    stepId?: string;
    message: string;
  };
}

export interface CancelledBoundary extends RunBoundaryBase {
  kind: "cancelled";
  status: "cancelled";
}

export interface ManualInterventionBoundary extends RunBoundaryBase {
  kind: "manual-intervention";
  status: "waiting";
  reason:
    | "loop-exhausted"
    | "workflow-unavailable"
    | "unsupported-waiting-state";
  intervention: {
    supported: false;
    message: string;
    maxAttempts?: number;
    attempts?: number;
  };
}

export type RunBoundary =
  | CompletedBoundary
  | ApprovalRequiredBoundary
  | InterruptedBoundary
  | FailedBoundary
  | CancelledBoundary
  | ManualInterventionBoundary;

export interface PendingRevisionView {
  approvalStepId: string;
  targetStepId: string;
  feedback: string;
  requestedAt: string;
  previousArtifact?: {
    name: string;
    path: string;
  };
}

export interface RunView {
  runId: string;
  workflow: string;
  checkpointToken: string;
  status: RunStatus;
  task?: string;
  startedAt: string;
  updatedAt: string;
  summary: string;
  currentStep?: RunStepView;
  steps: RunStepView[];
  artifacts: ArtifactMetadata[];
  allowedActions: RunAction[];
  resumable: boolean;
  workflowAvailable: boolean;
  workflowIssue?: string;
  resumeReason?: string;
  pendingRevision?: PendingRevisionView;
  boundary?: RunBoundary;
}

export interface ReadArtifactInput {
  runId: string;
  name: string;
  path?: string;
  version?: number;
}

export interface ArtifactView {
  runId: string;
  workflow: string;
  name: string;
  path: string;
  content: string;
  byteLength: number;
  lineCount: number;
  isCurrent: boolean;
  versioned: boolean;
  version?: number;
  versions: ArtifactVersionMetadata[];
}
