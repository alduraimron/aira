import type { AgentRuntime } from "../agent/runtime";
import type { ExecuteWorkflowParams } from "../executor";
import type { GitCommandRunner } from "../git";
import type { RunState } from "../run";

/** Advanced composition seam for injecting Aira's existing executor. */
export type CoreWorkflowExecutor = (
  params: ExecuteWorkflowParams,
) => Promise<RunState>;

export interface AiraCoreDependencies {
  agentRuntimeFactory?: () => AgentRuntime;
  executor?: CoreWorkflowExecutor;
  gitCommandRunner?: GitCommandRunner;
  clock?: () => Date;
  approvalDecisionApplier?: typeof import("../approval").applyApprovalDecision;
  artifactReader?: typeof import("../artifacts").readArtifact;
  artifactVersionReader?: typeof import("../artifacts").readArtifactVersion;
}
