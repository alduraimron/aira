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
  /** Optional Aira-owned JSONL audit log. */
  sessionLogPath?: string;
  /** Enables Aira's provider-neutral semantic completion contract. */
  completion?: AgentCompletionSpec;
}

export interface AgentStepResult {
  /**
   * True when the agent finished without a runtime, provider, or timeout
   * failure. Phase 8 does not treat this as semantic workflow completion.
   */
  success: boolean;
  /** The fresh provider session created for this attempt. */
  sessionId: string;
  finalText: string;
  timedOut: boolean;
  error?: string;
  /** Accepted semantic completion, independent from runtime success. */
  completion?: AgentCompletion;
  /** Semantic completion protocol failure, independent from runtime success. */
  completionError?: string;
}
