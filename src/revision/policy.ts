import { referenceOf, sameArtifact, type ArtifactRevision } from "../spec/domain/artifacts";
import { stableIssues, type DomainIssue } from "../spec/domain/primitives";
import type { RevisionRequest, RevisionResolution } from "./types";
export function validateRevisionResolution(request: RevisionRequest, resolution: RevisionResolution, artifact: ArtifactRevision): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (request.status !== "pending") issues.push({ code: "revision-not-pending", subject: request.id });
  if (artifact.spec_id !== request.spec_id || artifact.kind !== request.previous_artifact.kind ||
      !sameArtifact(referenceOf(artifact), resolution.resulting_artifact) || artifact.id === request.previous_artifact.revision)
    issues.push({ code: "revision-result-mismatch", subject: request.id });
  if (!artifact.lineage.some((e) => e.relation === "supersedes" && sameArtifact(e.target, request.previous_artifact)))
    issues.push({ code: "revision-predecessor-mismatch", subject: request.id });
  if (Date.parse(resolution.at) < Date.parse(request.requested_at)) issues.push({ code: "revision-time-invalid", subject: request.id });
  return stableIssues(issues);
}
