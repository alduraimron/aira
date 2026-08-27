import type { AgentCompletion, AgentCompletionSpec } from "./completion";

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
  /** Semantic completion protocol failure, independent from runtime success. */
  completionError?: string;
}
