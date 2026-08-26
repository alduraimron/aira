export interface WorkflowInput {
  required: boolean;
}

export interface AgentArtifact {
  name: string;
  filename: string;
  versioned?: boolean;
}

export interface StepBase {
  id: string;
  when?: string;
}

export interface AgentStep extends StepBase {
  uses: "agent";
  command: string;
  model?: string;
  thinking?: string;
  timeout?: number;
  retry?: number;
  tools?: string[];
  context?: Record<string, string>;
  artifact?: AgentArtifact;
}

export interface ShellCommand {
  name: string;
  run: string;
}

export interface ShellRunStep extends StepBase {
  uses: "shell";
  run: string;
  commands?: never;
  timeout?: number;
}

export interface ShellCommandsStep extends StepBase {
  uses: "shell";
  run?: never;
  commands: ShellCommand[];
  timeout?: number;
}

export type ShellStep = ShellRunStep | ShellCommandsStep;

export interface ApprovalStep extends StepBase {
  uses: "approval";
  artifact?: string;
  message?: string;
  revise?: string;
}

export interface LoopStep extends StepBase {
  uses: "loop";
  max_attempts: number;
  until: string;
  steps: WorkflowStep[];
}

export type NonLoopStep = AgentStep | ShellStep | ApprovalStep;
export type WorkflowStep = NonLoopStep | LoopStep;

export interface Workflow {
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  steps: WorkflowStep[];
}
