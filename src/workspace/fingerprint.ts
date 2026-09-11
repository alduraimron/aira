import { exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import type { BackendCapability, ExecutionBackend, WorkspaceFingerprint } from "./types";
/** Exact means every version/policy/provider/content component, not just a digest label. */
export const sameWorkspaceFingerprint = (a: WorkspaceFingerprint, b: WorkspaceFingerprint): boolean => exact(a, b);
export function checkBackendRequirements(required: readonly BackendCapability[], backend: ExecutionBackend): DomainIssue[] {
  return stableIssues(required.filter((capability) => backend.capabilities[capability] !== true)
    .map((capability) => ({ code: "backend-capability-unavailable", subject: capability })));
}
