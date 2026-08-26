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
}
