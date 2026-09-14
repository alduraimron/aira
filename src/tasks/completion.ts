import type { TaskDefinition } from "./types";
import type { TaskExecutionState } from "../execution/types";
import type { VerificationEvidence } from "../verification/types";
import { evidencePasses, type EvidenceContext } from "../verification/applicability";
import { sameArtifact, type ArtifactReference } from "../spec/domain/artifacts";
import { exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";

export interface TaskCompletionInput {
  readonly task: TaskDefinition; readonly state?: TaskExecutionState;
  readonly evidence: readonly VerificationEvidence[]; readonly evidence_contexts: readonly EvidenceContext[];
  readonly applicable_artifacts: readonly ArtifactReference[];
}
/** Task state is necessary, not sufficient. Recheck configured obligations (INV-TASK-002). */
export function evaluateTaskCompletion(input: TaskCompletionInput): DomainIssue[] {
  const issues: DomainIssue[] = [], task = input.task.identity.id;
  if (!input.state || input.state.status !== "completed") issues.push({ code: "task-not-completed", task });
  if (input.state && !exact(input.state.task, input.task.identity)) issues.push({ code: "task-state-definition-mismatch", task });
  for (const condition of input.task.completion) {
    if (condition.kind === "artifact-published") {
      if (!input.applicable_artifacts.some((a) => sameArtifact(a, condition.artifact))) issues.push({ code: "task-artifact-missing", task, subject: condition.artifact.revision });
    } else {
      const contexts = input.evidence_contexts.filter((c) => c.task.id === task && c.verifier.identity.id === condition.verifier && c.attempt.id === input.state?.current_attempt);
      if (!input.evidence.some((e) => e.task.id === task && e.verifier.id === condition.verifier && contexts.some((c) => evidencePasses(e, c))))
        issues.push({ code: "task-verification-missing", task, verifier: condition.verifier });
    }
  }
  return stableIssues(issues);
}
