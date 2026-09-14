import { compareText, exact, stableIssues, type DomainIssue } from "./primitives";
import { referenceOf, sameArtifact, type ArtifactRevision } from "./artifacts";
import type { Analysis } from "./analysis";
import type { Spec } from "./types";
import { behavioralProfileSnapshotSchema, validateBehavioralProfileSnapshot, type BehavioralProfileSnapshot } from "../../builtins/snapshots";
import type { BehavioralAssetCatalog } from "../../builtins/catalog";
import type { AssetCompatibilityEnvironment } from "../../builtins/compatibility";

/** Validates closed authoring attribution in addition to Spec/artifact schemas.
 * Human-authored content may have no behavioral input. Aira-generated content may not.
 * Snapshot byte verification is an explicit adapter observation, not inferred here.
 */
export function validateSpecBehavioralBindings(spec: Spec, revisions: readonly ArtifactRevision[], analyses: readonly Analysis[],
  snapshots: readonly { readonly snapshot: BehavioralProfileSnapshot; readonly verified_content_hash: BehavioralProfileSnapshot["identity"]["hash"] }[],
  catalog: BehavioralAssetCatalog, environment: AssetCompatibilityEnvironment): DomainIssue[] {
  const issues: DomainIssue[] = [];
  for (const binding of spec.behavioral_profiles) {
    const matching = snapshots.filter((s) => exact(s.snapshot.identity, binding.snapshot));
    const outputs = revisions.filter((r) => sameArtifact(referenceOf(r), binding.output));
    if (matching.length !== 1) { issues.push({ code: "behavioral-snapshot-unavailable-or-ambiguous", subject: binding.output.revision }); continue; }
    const { snapshot, verified_content_hash } = matching[0]!;
    if (!behavioralProfileSnapshotSchema.safeParse(snapshot).success) { issues.push({ code: "invalid-behavioral-profile-snapshot" }); continue; }
    if (verified_content_hash !== binding.snapshot.hash) issues.push({ code: "behavioral-snapshot-hash-mismatch", subject: snapshot.identity.id });
    if (snapshot.spec_id !== spec.id || snapshot.phase !== binding.phase || snapshot.generation !== binding.generation || BigInt(snapshot.generation) > BigInt(spec.generation))
      issues.push({ code: "behavioral-snapshot-scope-mismatch", subject: snapshot.identity.id });
    if (outputs.length !== 1 || outputs[0]!.spec_id !== spec.id || !exact(outputs[0]!.behavioral_profile, binding.snapshot))
      issues.push({ code: "behavioral-output-binding-mismatch", subject: binding.output.revision });
    if (binding.output.kind === "analysis") {
      const results = analyses.filter((a) => a.revision === binding.output.revision && a.spec_id === spec.id);
      const expected = { product: "product-analysis", "program-design": "program-design-analysis", "slice-plan": "slice-plan-analysis", requirements: "requirements-analysis", architecture: "architecture-analysis", tasks: "task-analysis", consistency: "architecture-analysis", "final-consistency": "final-spec-review" } as const;
      if (results.length !== 1 || expected[results[0]!.phase] !== binding.phase) issues.push({ code: "behavioral-analysis-phase-mismatch", subject: binding.output.revision });
    }
    issues.push(...validateBehavioralProfileSnapshot(snapshot, catalog, environment));
  }
  for (const revision of revisions) {
    if ((revision.behavioral_profile || revision.created.by.kind !== "human") &&
      spec.behavioral_profiles.filter((b) => sameArtifact(b.output, referenceOf(revision)) && exact(b.snapshot, revision.behavioral_profile)).length !== 1)
      issues.push({ code: "generated-artifact-behavioral-binding-missing", subject: revision.id });
  }
  return stableIssues(issues);
}
/** Profile adoption is semantic, not execution bookkeeping. History is append-only;
 * unchanged architecture-first output keeps its original authoring profile on revalidation.
 */
export function validateSpecBehavioralEvolution(previous: Spec, next: Spec): DomainIssue[] {
  const issues: DomainIssue[] = [];
  for (const binding of previous.behavioral_profiles) if (!next.behavioral_profiles.some((b) => exact(b, binding)))
    issues.push({ code: "behavioral-history-rewritten", subject: binding.output.revision });
  const config = (s: Spec) => ({ kind: s.kind, custom_kind: s.custom_kind, mode: s.mode, authoring_order: s.authoring_order,
    selections: [...s.behavioral_selections].sort((a, b) => compareText(a.role, b.role)),
    bindings: [...s.behavioral_profiles].sort((a, b) => compareText(a.output.revision, b.output.revision)) });
  if (!exact(config(previous), config(next)) && BigInt(next.generation) <= BigInt(previous.generation)) issues.push({ code: "behavioral-mutation-requires-spec-generation" });
  return stableIssues(issues);
}
