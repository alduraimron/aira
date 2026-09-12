import { describe, expect, test } from "bun:test";
import { behavioralProfileSnapshotSchema, validateBehavioralProfileSnapshot, validateImmutableBehavioralSnapshot, type BehavioralProfileSnapshot } from "../../../src/builtins/snapshots";
import { behavioralResolutionRequestSchema, resolveBehavioralProfiles } from "../../../src/builtins/resolution";
import { behavioralAssetPinSchema, type AuthoringBehavioralPhase } from "../../../src/builtins/roles";
import { validateSpecBehavioralBindings, validateSpecBehavioralEvolution } from "../../../src/spec/domain/behavior";
import { specSchema } from "../../../src/spec/domain/schema";
import { artifactRevisionSchema, approvedSpecSnapshotSchema, referenceOf, validateImmutableRevision } from "../../../src/spec/domain/artifacts";
import { evaluateSpecCompletion } from "../../../src/spec/domain/completion";
import { attemptRecordSchema } from "../../../src/execution/schema";
import { validateAttemptBehavior } from "../../../src/execution/behavior";
import { verificationEvidenceSchema } from "../../../src/verification/schema";
import { evidenceApplicability, sameApprovedSnapshot } from "../../../src/verification/applicability";
import { contextSnapshotSchema } from "../../../src/context/snapshot";
import { specGenerationSchema } from "../../../src/spec/domain/generations";
import { fixture, snapshot, backend } from "../fixtures";
import { builtinBundleManifestSchema } from "../../../src/builtins/bundle";
import { syntheticCompatibility } from "../behavioral-fixtures";
import { available, hash, library, metadata, pin, profile } from "./fixtures";

const phases = ["requirements-generation", "requirements-analysis", "design-generation", "design-analysis", "task-generation", "task-analysis"] as const;
function profileSnapshot(f: ReturnType<typeof library>, phase: AuthoringBehavioralPhase, suffix = "1") {
  const request = behavioralResolutionRequestSchema.parse({ ...f.request, required_roles: [phase] });
  const resolution = resolveBehavioralProfiles(request, f.catalog, f.environment);
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.issues));
  return behavioralProfileSnapshotSchema.parse({ schema: "aira.dev/behavioral-profile-snapshot/v1", identity: profile(`snapshot_${phase}_${suffix}`),
    spec_id: "spec_one", generation: "5", phase, request, resolution: resolution.value, created: metadata });
}
function authoringFixture() {
  const f = fixture(), l = library();
  const outputs = [f.req, f.analysisRevisions[0]!, f.des, f.analysisRevisions[1]!, f.ts, f.analysisRevisions[2]!];
  const snapshots = phases.map((phase, i) => {
    const record = profileSnapshot(l, phase);
    const output = outputs[i]!;
    const attributed = artifactRevisionSchema.parse({ ...output, behavioral_profile: record.identity,
      created: { ...output.created, by: { kind: "model", id: "test-model", implementation: "synthetic" } } });
    f.review.revisions = f.review.revisions.map((r) => r.id === output.id ? attributed : r);
    f.spec.behavioral_profiles.push({ output: referenceOf(attributed), phase, snapshot: record.identity, generation: record.generation });
    return { snapshot: record, verified_content_hash: record.identity.hash };
  });
  const validate = () => validateSpecBehavioralBindings(f.spec, f.review.revisions, f.review.analyses, snapshots, l.catalog, l.environment);
  return { f, l, outputs, snapshots, validate };
}

describe("INV-BUILTIN-002 / INV-LINEAGE-001/002: phase-specific immutable authoring history", () => {
  test("all six authoring activities bind exact profiles through immutable output revisions", () => {
    const f = authoringFixture(); expect(f.validate()).toEqual([]); expect(specSchema.safeParse(f.f.spec).success).toBe(true);
    expect(f.f.spec.behavioral_profiles.map((b) => b.phase)).toEqual([...phases]);
    expect(new Set(f.snapshots.map((s) => s.snapshot.identity.id)).size).toBe(6);
    for (const s of f.snapshots) expect(s.snapshot.resolution.decisions.some((d) => d.role === s.snapshot.phase && d.effective[0]!.asset.hash.startsWith("sha256:"))).toBe(true);
  });
  test("Spec history is explicit, not an optional implicit default", () => {
    const f = fixture();
    expect(specSchema.safeParse({ ...f.spec, behavioral_profiles: undefined }).success).toBe(false);
    expect(specSchema.safeParse({ ...f.spec, behavioral_selections: undefined }).success).toBe(false);
    expect(approvedSpecSnapshotSchema.safeParse({ ...f.run.snapshot, behavioral_assets: undefined }).success).toBe(false);
    expect(approvedSpecSnapshotSchema.safeParse({ ...f.run.snapshot, behavioral_profiles: undefined }).success).toBe(false);
  });
  test("human-origin documents may be unassisted; generated output cannot omit attribution", () => {
    const f = fixture(); expect(artifactRevisionSchema.safeParse(f.req).success).toBe(true);
    expect(artifactRevisionSchema.safeParse({ ...f.req, created: { ...f.req.created, by: { kind: "worker", id: "test", implementation: "test" } } }).success).toBe(false);
  });
  test.each(["missing", "hash", "scope", "output", "analysis", "ambiguous", "phase"])("snapshot %s mismatch fails closed", (change) => {
    const f = authoringFixture();
    if (change === "missing") f.snapshots.splice(0, 1);
    if (change === "hash") f.snapshots[0]!.verified_content_hash = hash(2);
    if (change === "scope") f.snapshots[0]!.snapshot.spec_id = "spec_other" as typeof f.f.spec.id;
    if (change === "output") f.f.review.revisions[1]!.behavioral_profile = profile("unknown");
    if (change === "analysis") f.f.review.analyses[0]!.phase = "tasks";
    if (change === "ambiguous") f.snapshots.push(f.snapshots[0]!);
    if (change === "phase") f.f.spec.behavioral_profiles[0]!.phase = "design-generation";
    expect(f.validate().length).toBeGreaterThan(0);
  });
  test("snapshot decoding is strict and a fabricated resolution cannot be published", () => {
    const f = library(), s = profileSnapshot(f, "requirements-generation"), selected = pin("requirements-generation", "2");
    f.catalog.assets.push(available(selected));
    expect(behavioralProfileSnapshotSchema.safeParse({ ...s, schema: "aira.dev/behavioral-profile-snapshot/v99" }).success).toBe(false);
    expect(behavioralProfileSnapshotSchema.safeParse({ ...s, phase: "arbitrary" }).success).toBe(false);
    const forged = { ...s, request: { ...s.request, spec: [selected] } };
    expect(validateBehavioralProfileSnapshot(forged, f.catalog, f.environment).map((i) => i.code)).toContain("behavioral-snapshot-resolution-mismatch");
    expect(validateImmutableBehavioralSnapshot(s, forged).map((i) => i.code)).toContain("immutable-behavioral-snapshot-overwrite");
  });
  test("snapshot adoption advances Spec generation; existing history cannot be rewritten or removed", () => {
    const f = authoringFixture(), next = structuredClone(f.f.spec);
    next.behavioral_selections.push(pin("requirements-generation", "2"));
    expect(validateSpecBehavioralEvolution(f.f.spec, next).map((i) => i.code)).toContain("behavioral-mutation-requires-spec-generation");
    next.generation = specGenerationSchema.parse("11"); expect(validateSpecBehavioralEvolution(f.f.spec, next)).toEqual([]);
    next.behavioral_profiles.shift(); expect(validateSpecBehavioralEvolution(f.f.spec, next).map((i) => i.code)).toContain("behavioral-history-rewritten");
  });
  test("changing the asset snapshot of an existing artifact is an immutable provenance overwrite", () => {
    const f = authoringFixture(), r = f.f.review.revisions.find((r) => r.id === f.f.req.id)!;
    expect(validateImmutableRevision(r, { ...r, behavioral_profile: profile("another") }).map((i) => i.code)).toContain("immutable-revision-overwrite");
  });
  test("design-first consistency review may use a newer profile without reauthoring unchanged design", () => {
    const f = fixture("design-first"), l = library();
    l.request.mode = "design-first"; l.request.authoring_order = "design-first";
    const designProfile = profileSnapshot(l, "design-generation");
    const reviewPin = pin("design-analysis", "2"); l.catalog.assets.push(available(reviewPin)); l.request.spec = [reviewPin];
    const reviewProfile = profileSnapshot(l, "design-analysis", "2");
    const design = artifactRevisionSchema.parse({ ...f.des, behavioral_profile: designProfile.identity });
    const review = artifactRevisionSchema.parse({ ...f.analysisRevisions[3]!, behavioral_profile: reviewProfile.identity });
    f.review.revisions = f.review.revisions.map((r) => r.id === design.id ? design : r.id === review.id ? review : r);
    f.spec.behavioral_profiles = [
      { output: referenceOf(design), phase: "design-generation", snapshot: designProfile.identity, generation: designProfile.generation },
      { output: referenceOf(review), phase: "design-analysis", snapshot: reviewProfile.identity, generation: reviewProfile.generation },
    ];
    expect(validateSpecBehavioralBindings(f.spec, f.review.revisions, f.review.analyses,
      [designProfile, reviewProfile].map((s) => ({ snapshot: s, verified_content_hash: s.identity.hash })), l.catalog, l.environment)).toEqual([]);
    expect(referenceOf(design)).toEqual(referenceOf(f.des)); expect(f.spec.approvals).toEqual(f.review.spec.approvals);
    expect(reviewProfile.resolution.decisions.find((d) => d.role === "design-analysis")!.effective).toEqual([reviewPin]);
  });
  test("removing a previously pinned asset fails even though a newer default is installed", () => {
    const f = authoringFixture();
    f.l.catalog.assets = f.l.catalog.assets.filter((a) => a.revision.identity.id !== "builtin.test.requirements-generation");
    f.l.catalog.assets.push(available(pin("requirements-generation", "2")));
    expect(f.validate().map((i) => i.code)).toContain("pinned-asset-unavailable");
  });
});

describe("INV-BUILTIN-002/003: execution, context, policy and evidence attribution", () => {
  test("attempt references exact implementation/context/policy/execution/verification assets without full records", () => {
    const f = fixture();
    expect(validateAttemptBehavior(f.attempt, f.tasks.tasks[0]!, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment)).toEqual([]);
    expect(f.attempt.behavior.pins.map((p) => p.role)).toEqual(["implementation", "context-profile", "capability-profile", "execution-profile", "verification-profile"]);
    expect(f.attempt.behavior.pins.every((p) => !("metadata" in p.asset) && !("content" in p.asset))).toBe(true);
    expect(evaluateSpecCompletion(f).complete).toBe(true);
  });
  test.each(["implementation", "context-profile", "capability-profile", "execution-profile"])("attempt cannot omit %s", (role) => {
    const f = fixture();
    expect(attemptRecordSchema.safeParse({ ...f.attempt, behavior: { ...f.attempt.behavior, pins: f.attempt.behavior.pins.filter((p) => p.role !== role) } }).success).toBe(false);
  });
  test("repair must pin the actual repair input, not just implementation", () => {
    const f = fixture(); expect(attemptRecordSchema.safeParse({ ...f.attempt, behavior: { ...f.attempt.behavior, purpose: "repair" } }).success).toBe(false);
    const repair = pin("repair", "2");
    const a = attemptRecordSchema.parse({ ...f.attempt, behavior: { purpose: "repair", pins: [...f.attempt.behavior.pins, repair] } });
    expect(a.behavior.pins.some((p) => p.role === "repair")).toBe(true);
    expect(validateAttemptBehavior(a, f.tasks.tasks[0]!, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment).map((i) => i.code)).toContain("attempt-unselected-behavioral-asset");
  });
  test.each(["implementation-review", "verification-review", "final-spec-review"] as const)("evidence can pin exact %s analysis through its existing verifier profile", (role) => {
    const f = fixture(), review = pin(role), asset = review.asset;
    if (asset.kind !== "analysis-profile") throw new Error("test contract");
    const approved = approvedSpecSnapshotSchema.parse({ ...f.run.snapshot, behavioral_assets: [...f.run.snapshot.behavioral_assets, review] });
    const attempt = attemptRecordSchema.parse({ ...f.attempt, snapshot: approved, behavior: { purpose: role, pins: [...f.attempt.behavior.pins, review] } });
    const evidence = verificationEvidenceSchema.parse({ ...f.record, snapshot: approved, behavioral_assets: attempt.behavior.pins, review_actor: { kind: "agent", implementation: asset.profile } });
    const context = { ...f.evidenceContext, attempt, snapshot: approved, authority: { ...f.evidenceContext.authority, snapshot: approved }, allow_agent_review: true,
      verifier: { ...f.plan.verifiers[0]!, definition: { kind: "agent-review" as const, rubric: "Synthetic", review_profile: asset.profile } } };
    expect(evidenceApplicability(evidence, context).applicable).toBe(true);
    expect(evidenceApplicability({ ...evidence, behavioral_assets: f.record.behavioral_assets }, context).reasons.map((i) => i.code)).toContain("evidence-review-asset-missing");
  });
  test("evidence pins cannot be substituted after an attempt", () => {
    const f = fixture(), changed = f.record.behavioral_assets.map((p) => p.role === "implementation" ? pin("implementation", "2") : p);
    expect(evidenceApplicability({ ...f.record, behavioral_assets: changed }, f.evidenceContext).reasons.map((i) => i.code)).toContain("evidence-behavioral-assets-mismatch");
  });
  test("context and policy/execution domain references must agree with asset pins", () => {
    const f = fixture();
    expect(contextSnapshotSchema.safeParse({ ...snapshot(), resolver_policy: profile("different") }).success).toBe(false);
    expect(attemptRecordSchema.safeParse({ ...f.attempt, execution_profile: profile("different") }).success).toBe(false);
    expect(verificationEvidenceSchema.safeParse({ ...f.record, profile: profile("different") }).success).toBe(false);
    expect(validateAttemptBehavior(f.attempt, f.tasks.tasks[0]!, [], f.behavioral.catalog, f.behavioral.environment).map((i) => i.code)).toContain("behavioral-context-unavailable");
  });
  test("explicit allowed task pin overrides a Spec pin, but missing explicit selection is rejected", () => {
    const f = fixture(), selected = pin("implementation", "2", "impl", "acme"), task = { ...f.tasks.tasks[0]!, behavioral_selections: [selected] };
    f.behavioral.catalog.assets.push(available(selected));
    const attempt = attemptRecordSchema.parse({ ...f.attempt, behavior: { purpose: "implementation", pins: f.attempt.behavior.pins.map((p) => p.role === selected.role ? selected : p) } });
    expect(validateAttemptBehavior(attempt, task, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment)).toEqual([]);
    expect(validateAttemptBehavior(attempt, f.tasks.tasks[0]!, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment).map((i) => i.code)).toContain("attempt-unselected-behavioral-asset");
  });
  test("child capability pins cannot replace a parent layer at dispatch or evidence publication", () => {
    const f = fixture(), child = pin("capability-profile", "1", "restricted", "acme");
    expect(attemptRecordSchema.safeParse({ ...f.attempt, behavior: { purpose: "implementation", pins: [...f.attempt.behavior.pins.filter((p) => p.role !== "capability-profile"), child] } }).success).toBe(false);
    const task = { ...f.tasks.tasks[0]!, behavioral_selections: [child] };
    expect(validateAttemptBehavior(f.attempt, task, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment).map((i) => i.code)).toContain("attempt-capability-layer-omitted");
    const attempt = { ...f.attempt, behavior: { ...f.attempt.behavior, pins: [...f.attempt.behavior.pins, child] } };
    expect(evidenceApplicability(f.record, { ...f.evidenceContext, attempt }).reasons.map((i) => i.code)).toContain("evidence-behavioral-assets-mismatch");
  });
  test("dispatch uses the same idempotent capability layers as resolution while checking every candidate bundle", () => {
    const f = fixture(), direct = f.attempt.behavior.pins.find((p) => p.role === "capability-profile")!;
    const bundle = builtinBundleManifestSchema.parse({ schema: "aira.dev/builtin-bundle/v1", identity: { id: "bundle.aira.attempt", revision: "1", hash: hash(803) },
      distribution_version: "test", compatibility: syntheticCompatibility, assets: [direct.asset], defaults: [], spec_kinds: [], modes: [] });
    f.behavioral.catalog.bundles.push({ manifest: bundle, verified_content_hash: bundle.identity.hash });
    const bundled = { ...direct, bundle: bundle.identity };
    const pins = f.attempt.behavior.pins.map((p) => p.role === direct.role ? bundled : p);
    const attempt = attemptRecordSchema.parse({ ...f.attempt, snapshot: { ...f.attempt.snapshot, behavioral_assets: pins }, behavior: { purpose: "implementation", pins } });
    const task = { ...f.tasks.tasks[0]!, behavioral_selections: [direct] };
    expect(validateAttemptBehavior(attempt, task, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment)).toEqual([]);
    task.behavioral_selections = [behavioralAssetPinSchema.parse({ ...direct, bundle: { ...bundle.identity, hash: hash(804) } })];
    expect(validateAttemptBehavior(attempt, task, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment).map((i) => i.code)).toContain("pinned-bundle-unavailable");
  });
  test("execution recipe pins preserve the existing typed recipe reference in attempt/evidence inputs", () => {
    const f = fixture(), recipe = pin("execution-recipe");
    f.behavioral.catalog.assets.push(available(recipe));
    const pins = [...f.attempt.behavior.pins, recipe];
    const approved = approvedSpecSnapshotSchema.parse({ ...f.attempt.snapshot, behavioral_assets: pins });
    const attempt = attemptRecordSchema.parse({ ...f.attempt, snapshot: approved, behavior: { purpose: "implementation", pins } });
    const evidence = verificationEvidenceSchema.parse({ ...f.record, snapshot: approved, behavioral_assets: pins });
    expect(validateAttemptBehavior(attempt, f.tasks.tasks[0]!, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment)).toEqual([]);
    expect(evidence.behavioral_assets.find((p) => p.role === "execution-recipe")).toEqual(recipe);
  });
  test("completion fails closed for unavailable/historical wrong-hash behavior", () => {
    const f = fixture(); f.behavioral.catalog.assets.shift();
    const result = evaluateSpecCompletion(f);
    expect(result.complete).toBe(false); expect(result.blockers.map((i) => i.code)).toContain("pinned-asset-unavailable");
  });
  test("the actual attempt backend, not a more capable supplied environment, is checked", () => {
    const f = fixture(); f.behavioral.catalog.assets[0]!.revision.compatibility.backend_capabilities = ["force_termination"];
    const attempt = { ...f.attempt, backend: backend(false) };
    expect(validateAttemptBehavior(attempt, f.tasks.tasks[0]!, f.behavioral.contexts, f.behavioral.catalog, { ...f.behavioral.environment, backend: backend() }).length).toBeGreaterThan(0);
  });
  test("historical execution stays attributable after independent defaults evolve", () => {
    const f = fixture(), before = JSON.stringify(f.attempt), newer = pin("implementation", "2");
    f.behavioral.catalog.assets.push(available(newer));
    f.spec.behavioral_selections = [newer];
    expect(validateAttemptBehavior(f.attempt, f.tasks.tasks[0]!, f.behavioral.contexts, f.behavioral.catalog, f.behavioral.environment)).toEqual([]);
    expect(evidenceApplicability(f.record, f.evidenceContext).applicable).toBe(true); expect(JSON.stringify(f.attempt)).toBe(before);
  });
  test("approved snapshot equality includes behavioral pins and authoring lineage", () => {
    const f = fixture(), s = f.run.snapshot;
    expect(sameApprovedSnapshot(s, { ...s, behavioral_assets: [...s.behavioral_assets].reverse() })).toBe(true);
    expect(sameApprovedSnapshot(s, { ...s, behavioral_assets: s.behavioral_assets.map((p) => p.role === "implementation" ? pin("implementation", "2") : p) })).toBe(false);
    const a = authoringFixture();
    expect(sameApprovedSnapshot(s, { ...s, behavioral_profiles: a.f.spec.behavioral_profiles })).toBe(false);
  });
});

if (false) {
  const s: BehavioralProfileSnapshot = profileSnapshot(library(), "requirements-generation");
  // @ts-expect-error phase history is immutable
  s.resolution.decisions.push(s.resolution.decisions[0]!);
  // @ts-expect-error snapshot reference immutable after publication
  s.identity.hash = hash(1);
  void s;
}
