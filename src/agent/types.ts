import type { AgentCompletion, AgentCompletionSpec } from "./completion";

interface AgentRuntimeEventBase {
  stepId: string;
}

export type AgentRuntimeEvent =
  | (AgentRuntimeEventBase & {
      type: "agent.started";
      model?: string;
      sessionId?: string;
    })
  | (AgentRuntimeEventBase & {
      type: "agent.tool.started";
      tool: string;
      summary?: string;
    })
  | (AgentRuntimeEventBase & {
      type: "agent.tool.completed";
      tool: string;
      success: boolean;
    })
  | (AgentRuntimeEventBase & {
      type: "agent.retry";
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
    });

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void;

export interface AgentStepRequest {
  stepId: string;
  prompt: string;
  cwd: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  /** Timeout in seconds. */
  timeoutSeconds?: number;
  /** Cancels active provider work without turning the cancellation into a timeout. */
  signal?: AbortSignal;
  /** Optional Aira-owned JSONL audit log. */
  sessionLogPath?: string;
  /** Receives safe provider-neutral live activity for this attempt. */
  onEvent?: AgentRuntimeEventListener;
  /** Enables Aira's provider-neutral semantic completion contract. */
  completion?: AgentCompletionSpec;
}

export interface AgentStepResult {
  /**
   * True when the agent finished without a runtime, provider, timeout, or
   * external-abort failure. This does not imply semantic workflow completion.
   */
  success: boolean;
  /** The fresh provider session created for this attempt. */
  sessionId: string;
  finalText: string;
  timedOut: boolean;
  /** True only for an external user or system cancellation. */
  aborted?: boolean;
  error?: string;
  /** Accepted semantic completion, independent from runtime success. */
  completion?: AgentCompletion;
  /** Protocol failure when no semantic completion was accepted. */
  completionError?: string;
}
