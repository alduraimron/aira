import type { AgentRuntimeEvent } from "../agent/types";

interface StepEventBase {
  stepId: string;
  parentStepId?: string;
}

export type AiraExecutionEvent =
  | AgentRuntimeEvent
  | (StepEventBase & {
      type: "step.started";
      stepType: string;
      model?: string;
      attempt?: number;
    })
  | (StepEventBase & {
      type: "step.completed";
      success: true;
      durationMs?: number;
    })
  | (StepEventBase & {
      type: "step.failed";
      error?: string;
      durationMs?: number;
    })
  | (StepEventBase & {
      type: "step.skipped";
    })
  | (StepEventBase & {
      type: "step.waiting";
      message?: string;
    })
  | (StepEventBase & {
      type: "step.retry";
      attempt: number;
      maxAttempts: number;
    })
  | (StepEventBase & {
      type: "loop.iteration.started";
      attempt: number;
      maxAttempts: number;
    })
  | (StepEventBase & {
      type: "artifact.written";
      artifact: string;
    })
  | (StepEventBase & {
      type: "shell.started";
      command: string;
    })
  | (StepEventBase & {
      type: "shell.completed";
      success: boolean;
      exitCode?: number;
      durationMs?: number;
    })
  | (StepEventBase & {
      type: "approval.waiting";
      message?: string;
    });

export type ExecutionEventListener = (event: AiraExecutionEvent) => void;
