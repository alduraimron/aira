import { referenceOf, sameArtifact, type ArtifactReference, type ArtifactRevision,
  type ValidationRecord, type ArtifactInvalidation } from "./artifacts";
import type { Analysis } from "./analysis";
import type { SpecGeneration } from "./generations";
import { compareText, cyclicComponents, stableIssues, type DomainIssue, type ContentHash } from "./primitives";

export interface LineageContext {
  readonly revisions: readonly ArtifactRevision[];
  readonly current: readonly ArtifactReference[];
  readonly proposed: readonly ArtifactReference[];
  readonly validations: readonly ValidationRecord[];
  readonly invalidations: readonly ArtifactInvalidation[];
  readonly analyses: readonly Analysis[];
  readonly generation: SpecGeneration;
  /** Measured canonical semantic-entity bodies, supplied by an authenticating adapter. */
  readonly entities?: readonly { readonly artifact: ArtifactReference; readonly entities: readonly { readonly id: string; readonly hash: ContentHash }[] }[];
}
const exists = (context: LineageContext, ref: ArtifactReference): boolean =>
  context.revisions.some((r) => sameArtifact(referenceOf(r), ref));
const selected = (context: LineageContext, ref: ArtifactReference): boolean =>
  context.current.some((r) => sameArtifact(r, ref));

function validationUsable(context: LineageContext, record: ValidationRecord): boolean {
  const analysis = context.analyses.find((a) => a.revision === record.analysis.revision);
  return record.outcome === "consistent" && BigInt(record.generation) <= BigInt(context.generation) &&
    selected(context, record.analysis) && exists(context, record.subject) &&
    record.against.every((r) => selected(context, r)) && analysis?.outcome === "consistent" &&
    [record.subject, ...record.against].every((r) => analysis.inputs.some((i) => sameArtifact(i, r)));
}

/** Only content provenance contributes to derivation cycles, never validated_against. */
export function currentLineageValidity(context: LineageContext): DomainIssue[] {
  const issues: DomainIssue[] = [], edges = new Map<string, string[]>();
  for (const revision of context.revisions) {
    if (edges.has(revision.id)) issues.push({ code: "duplicate-artifact-revision", subject: revision.id });
    edges.set(revision.id, [...new Set([...(edges.get(revision.id) ?? []), ...revision.lineage.map((e) => e.target.revision)])]);
    for (const edge of revision.lineage) {
      if (edge.relation === "derived_from" && edge.scope && !scopeMatches(context, edge.target, edge.scope))
        issues.push({ code: "lineage-entity-scope-unverified", subject: revision.id, related: [edge.target.revision] });
      if (!exists(context, edge.target)) issues.push({ code: "unknown-lineage-reference", subject: revision.id, related: [edge.target.revision] });
      const parent = context.revisions.find((r) => r.id === edge.target.revision);
      if (parent && parent.spec_id !== revision.spec_id) issues.push({ code: "cross-spec-lineage", subject: revision.id });
    }
  }
  for (const component of cyclicComponents(edges)) issues.push({ code: "derivation-cycle", related: component });
  for (const ref of [...context.current, ...context.proposed]) {
    if (!exists(context, ref)) issues.push({ code: "unknown-artifact-reference", subject: ref.revision });
  }
  for (const ref of context.current) {
    if (context.current.filter((r) => r.revision === ref.revision).length > 1 ||
      (ref.kind !== "analysis" && context.current.filter((r) => r.kind === ref.kind).length > 1))
      issues.push({ code: "ambiguous-current-artifact", subject: ref.kind });
  }
  const validationKeys = new Set<string>();
  for (const v of context.validations) {
    if (![v.subject, v.analysis, ...v.against].every((r) => exists(context, r)))
      issues.push({ code: "unknown-validation-reference", subject: v.subject.revision });
    for (const against of v.against) {
      const key = `${v.subject.revision}:${against.kind}`;
      if (validationKeys.has(key)) issues.push({ code: "ambiguous-revalidation", subject: v.subject.revision, related: [against.kind] });
      validationKeys.add(key);
    }
  }
  for (const invalidation of context.invalidations) {
    if (!exists(context, invalidation.subject)) issues.push({ code: "unknown-invalidation-reference", subject: invalidation.subject.revision });
    if (BigInt(invalidation.generation) > BigInt(context.generation)) issues.push({ code: "future-invalidation", subject: invalidation.subject.revision });
  }
  for (const analysis of context.analyses) {
    const revision = context.revisions.find((r) => r.id === analysis.revision);
    if (!revision || revision.kind !== "analysis" || revision.spec_id !== analysis.spec_id) issues.push({ code: "analysis-revision-mismatch", subject: analysis.revision });
    if (context.analyses.filter((a) => a.revision === analysis.revision).length !== 1) issues.push({ code: "duplicate-analysis-revision", subject: analysis.revision });
    for (const input of analysis.inputs) if (!exists(context, input)) issues.push({ code: "unknown-analysis-input", subject: analysis.revision, related: [input.revision] });
  }
  return stableIssues(issues);
}

/** Current effective freshness dependencies, with explicit exact-bound revalidation overrides.
 * Same-kind predecessor provenance is historical, not a demand to keep the predecessor current.
 * Applicability may contain architecture-first mutual consistency cycles; a monotone fixed point
 * propagates invalidity without mistaking those for derivation cycles (INV-LINEAGE-001/002).
 */
function scopeMatches(context: LineageContext, artifact: ArtifactReference, scope: readonly { readonly id: string; readonly hash: ContentHash }[]): boolean {
  const observations = context.entities?.filter((o) => sameArtifact(o.artifact, artifact)) ?? [];
  return observations.length === 1 && scope.every((s) => observations[0]!.entities.filter((e) => e.id === s.id && e.hash === s.hash).length === 1);
}
function effectiveDependencies(context: LineageContext, revision: ArtifactRevision): ArtifactReference[] {
  const validations = context.validations.filter((v) => sameArtifact(v.subject, referenceOf(revision)) && validationUsable(context, v));
  const dependencies: ArtifactReference[] = [];
  for (const edge of revision.lineage) {
    if (edge.relation === "supersedes" || edge.target.kind === revision.kind) continue;
    const replacement = validations.flatMap((v) => v.against).find((r) => r.kind === edge.target.kind);
    const current = context.current.find((r) => r.kind === edge.target.kind);
    const scoped = edge.relation === "derived_from" && edge.scope && current &&
      scopeMatches(context, edge.target, edge.scope) && scopeMatches(context, current, edge.scope) ? current : undefined;
    dependencies.push(replacement ?? scoped ?? edge.target);
  }
  for (const v of validations) dependencies.push(...v.against, v.analysis);
  if (revision.kind === "analysis") dependencies.push(...(context.analyses.find((a) => a.revision === revision.id)?.inputs ?? []));
  return dependencies;
}
export interface StalenessReport {
  readonly valid: boolean;
  readonly issues: readonly DomainIssue[];
  readonly stale: readonly { revision: string; reasons: readonly DomainIssue[] }[];
}
export function deriveStaleness(context: LineageContext): StalenessReport {
  const issues = currentLineageValidity(context);
  const causes: { origin: string; issue: DomainIssue; inputs: Set<string> }[] = [];
  const affected = new Map<string, Set<number>>();
  const dependencies = new Map<string, ArtifactReference[]>(context.revisions.map((r) => [r.id, effectiveDependencies(context, r)]));
  const add = (origin: string, issue: DomainIssue, inputs: readonly ArtifactReference[] = []): void => {
    const id = causes.length;
    causes.push({ origin, issue, inputs: new Set(inputs.map((r) => r.revision)) });
    const set = affected.get(origin) ?? new Set<number>(); set.add(id); affected.set(origin, set);
  };
  for (const invalidation of context.invalidations) if (exists(context, invalidation.subject))
    add(invalidation.subject.revision, { code: "artifact-explicitly-invalidated", subject: invalidation.subject.revision });
  for (const revision of context.revisions) {
    for (const dep of dependencies.get(revision.id) ?? []) if (!selected(context, dep))
      add(revision.id, { code: "upstream-revision-changed", subject: revision.id, related: [dep.revision] }, context.current.filter((r) => r.kind === dep.kind));
    for (const validation of context.validations.filter((v) => sameArtifact(v.subject, referenceOf(revision)))) if (!validationUsable(context, validation))
      add(revision.id, { code: "validation-inapplicable", subject: revision.id, related: [validation.analysis.revision] },
        context.current.filter((r) => validation.against.some((a) => a.kind === r.kind)));
  }
  // Propagate each cause, not just a boolean. A new authoritative input cannot be
  // invalidated by its own invalidation wave returning through validated_against.
  // Example: r2 informed by d1 stays reviewable while d1 awaits validation against
  // r2. Other independent causes still invalidate r2. This preserves ADR-004's
  // requirements-approval-before-architecture-revalidation ordering without a cycle.
  let changed = true;
  while (changed) {
    changed = false;
    for (const revision of context.revisions) for (const dep of dependencies.get(revision.id) ?? []) {
      for (const cause of [...(affected.get(dep.revision) ?? [])]) {
        if (causes[cause]!.inputs.has(revision.id)) continue;
        const set = affected.get(revision.id) ?? new Set<number>();
        if (!set.has(cause)) { set.add(cause); affected.set(revision.id, set); changed = true; }
      }
    }
  }
  const stale = [...affected.keys()].sort(compareText).map((revision) => ({ revision,
    reasons: stableIssues([
      ...causes.filter((c) => c.origin === revision).map((c) => c.issue),
      ...(dependencies.get(revision) ?? []).filter((d) => [...(affected.get(d.revision) ?? [])]
        .some((c) => affected.get(revision)!.has(c) && !causes[c]!.inputs.has(revision)))
        .map((d) => ({ code: "upstream-artifact-stale", subject: revision, related: [d.revision] })),
    ]),
  }));
  return { valid: issues.length === 0, issues, stale };
}
export function artifactApplicability(context: LineageContext, ref: ArtifactReference, allowProposed = false): { applicable: boolean; reasons: DomainIssue[] } {
  const report = deriveStaleness(context), reasons = [...report.issues];
  if (!selected(context, ref) && !(allowProposed && context.proposed.some((r) => sameArtifact(r, ref))))
    reasons.push({ code: "artifact-not-current", subject: ref.revision });
  if (report.stale.some((r) => r.revision === ref.revision)) reasons.push({ code: "artifact-stale", subject: ref.revision });
  return { applicable: reasons.length === 0, reasons: stableIssues(reasons) };
}
export function downstreamAffectedArtifacts(context: LineageContext, changed: readonly ArtifactReference[]): ArtifactReference[] {
  const affected = new Set(changed.map((r) => r.revision));
  let progress = true;
  while (progress) {
    progress = false;
    for (const r of context.revisions) {
      const inputs = [...r.lineage.filter((e) => e.relation !== "supersedes" && e.target.kind !== r.kind).map((e) => e.target),
        ...context.validations.filter((v) => sameArtifact(v.subject, referenceOf(r))).flatMap((v) => [...v.against, v.analysis])];
      if (!affected.has(r.id) && inputs.some((d) => affected.has(d.revision))) { affected.add(r.id); progress = true; }
    }
  }
  return context.revisions.filter((r) => affected.has(r.id) && !changed.some((c) => c.revision === r.id))
    .map(referenceOf).sort((a, b) => compareText(a.revision, b.revision));
}
export function hasApplicableDependency(context: LineageContext, subject: ArtifactReference, parent: ArtifactReference): boolean {
  const revision = context.revisions.find((r) => sameArtifact(referenceOf(r), subject));
  return !!revision && effectiveDependencies(context, revision).some((r) => sameArtifact(r, parent));
}
export function hasConsistencyBinding(context: LineageContext, subject: ArtifactReference, against: ArtifactReference): boolean {
  return context.validations.some((v) => sameArtifact(v.subject, subject) && v.against.some((r) => sameArtifact(r, against)) && validationUsable(context, v));
}
