import type { AgentStepRequest, AgentStepResult } from "./types";

/** Provider-neutral execution boundary for one coding-agent attempt. */
export interface AgentRuntime {
  runStep(request: AgentStepRequest): Promise<AgentStepResult>;
}
