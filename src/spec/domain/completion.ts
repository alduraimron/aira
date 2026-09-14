import type { SpecReviewContext } from "./review";
import { evaluateSpecGates, lineageContext, obligationWaived } from "./review";
import { artifactApplicability } from "./lineage";
import { sameArtifact, sameSpecBehavioralBindings } from "./artifacts";
import { exact, stableIssues, type DomainIssue } from "./primitives";
import type { Requirements } from "./requirements";
import type { SystemArchitecture } from "./architecture";
import { buildTraceability, type TraceabilityReport } from "./traceability";
import { validateTaskGraph, type TaskReferenceCatalog } from "../../tasks/graph";
import type { Tasks } from "../../tasks/types";
import type { AttemptRecord, ExecutionRun } from "../../execution/types";
import type { VerificationEvidence, VerificationPlan } from "../../verification/types";
import { evidenceApplicability, evidencePasses, sameApprovedSnapshot, validateEvidenceIdentities, type EvidenceContext } from "../../verification/applicability";
import type { ExecutionBackend, WorkspaceObservation } from "../../workspace/types";
import { checkBackendRequirements } from "../../workspace/fingerprint";
import { checkLifecycleTransition, type SpecLifecycle } from "./lifecycle";
import { specSchema } from "./schema";
import { requirementsSchema } from "./requirements";
import { architectureSchema } from "./architecture";
import { artifactRevisionSchema } from "./artifacts";
import { analysisSchema } from "./analysis";
import { tasksSchema } from "../../tasks/schema";
import { executionRunSchema, attemptRecordSchema } from "../../execution/schema";
import { verificationPlanSchema, verificationEvidenceSchema } from "../../verification/schema";
import { executionBackendSchema, workspaceObservationSchema } from "../../workspace/schema";
import { humanWaiverSchema, specApprovalRecordSchema } from "../../approval/spec-records";
import { validateSpecBehavioralBindings } from "./behavior";
import { validateAttemptBehavior } from "../../execution/behavior";
import { validatePinnedAssets } from "../../builtins/catalog";
import { productDefinitionSchema, type ProductDefinition } from "./product";
import { programDesignSchema, type ProgramDesign } from "./program-design";
import { slicePlanSchema, evaluateSliceCompletion, type SlicePlan } from "./slices";
import { planningKinds } from "./planning-kinds";
import { validateFindingTargets } from "./planning-integrity";

export interface CompletionInput {
  readonly review: SpecReviewContext;
  readonly product: ProductDefinition;
  readonly program_design: ProgramDesign;
  readonly slices: SlicePlan;
  readonly requirements: Requirements;
  readonly architecture: SystemArchitecture;
  readonly tasks: Tasks;
  readonly plan: VerificationPlan;
  readonly catalog: TaskReferenceCatalog;
  readonly run?: ExecutionRun;
  readonly attempts: readonly AttemptRecord[];
  readonly evidence: readonly VerificationEvidence[];
  readonly workspace: WorkspaceObservation;
  readonly backend: ExecutionBackend;
  readonly behavioral: {
    readonly catalog: Parameters<typeof validatePinnedAssets>[1];
    readonly environment: Parameters<typeof validatePinnedAssets>[2];
    readonly snapshots: Parameters<typeof validateSpecBehavioralBindings>[3];
    readonly contexts: Parameters<typeof validateAttemptBehavior>[2];
  };
}
export interface CompletionReport {
  readonly complete: boolean;
  readonly blockers: readonly DomainIssue[];
  readonly traceability: TraceabilityReport;
}
export { evaluateTaskCompletion, type TaskCompletionInput } from "../../tasks/completion";
import { evaluateTaskCompletion } from "../../tasks/completion";
function evidenceContexts(input: CompletionInput): EvidenceContext[] {
  if (!input.run || !input.review.spec.run_binding) return [];
  const contexts: EvidenceContext[] = [];
  for (const task of input.tasks.tasks) {
    const states = input.run.tasks.filter((s) => s.task.id === task.identity.id);
    if (states.length !== 1) continue;
    const attempts = input.attempts.filter((a) => a.id === states[0]!.current_attempt);
    if (attempts.length !== 1) continue;
    const attempt = attempts[0]!;
    const authorities = input.run.authorities.filter((a) => a.attempt === attempt.id);
    if (authorities.length !== 1) continue;
    for (const verifier of input.plan.verifiers.filter((v) => v.tasks.includes(task.identity.id) && task.verifiers.includes(v.identity.id))) {
      const selections = input.run.current_evidence.filter((e) => exact(e.task, task.identity) && e.verifier === verifier.identity.id);
      if (selections.length !== 1) continue;
      contexts.push({ snapshot: input.review.spec.run_binding.snapshot, task: task.identity, attempt,
        authority: authorities[0]!, workspace: input.workspace.fingerprint, backend: input.backend,
        verifier, profile: input.plan.profile, allow_agent_review: input.review.spec.completion_policy.allow_agent_review,
        selected_evidence: selections[0]!.evidence });
    }
  }
  return contexts;
}
export function evaluateSpecCompletion(input: CompletionInput): CompletionReport {
  const contracts = [
    ["product", productDefinitionSchema, input.product], ["program-design", programDesignSchema, input.program_design], ["slice-plan", slicePlanSchema, input.slices],
    ["spec", specSchema, input.review.spec], ["requirements", requirementsSchema, input.requirements],
    ["architecture", architectureSchema, input.architecture], ["tasks", tasksSchema, input.tasks], ["verification-plan", verificationPlanSchema, input.plan],
    ["workspace-observation", workspaceObservationSchema, input.workspace], ["execution-backend", executionBackendSchema, input.backend],
    ...(input.run ? [["execution-run", executionRunSchema, input.run] as const] : []),
    ...input.review.revisions.map((r) => [r.id, artifactRevisionSchema, r] as const),
    ...input.review.analyses.map((a) => [a.revision, analysisSchema, a] as const),
    ...input.review.approvals.map((a) => [a.id, specApprovalRecordSchema, a] as const),
    ...input.review.waivers.map((w) => [w.id, humanWaiverSchema, w] as const),
    ...input.attempts.map((a) => [a.id, attemptRecordSchema, a] as const),
    ...input.evidence.map((e) => [e.id, verificationEvidenceSchema, e] as const),
  ] as const;
  const malformed = contracts.filter(([, schema, value]) => !schema.safeParse(value).success)
    .flatMap(([subject, , value]) => [{ code: "invalid-domain-contract", subject },
      ...(["product", "program-design", "slice-plan"].includes(subject) ? [{ code: `${subject}-${value ? "invalid" : "missing"}`, subject }] : [])]);
  if (malformed.length) return { complete: false, blockers: stableIssues(malformed), traceability: { edges: [], requirements: [], product_outcomes: [], success_criteria: [], evidence: [], issues: [] } };
  const { spec } = input.review, lineage = lineageContext(input.review), policy = spec.completion_policy;
  const kinds = policy.verification_plan_approval_required ? [...planningKinds, "verification-plan"] as const : planningKinds;
  const blockers: DomainIssue[] = [...evaluateSpecGates(input.review, kinds), ...validateTaskGraph(input.tasks, { ...input.catalog, requirements: input.requirements.requirements,
      decisions: input.architecture.decisions, program_decisions: input.program_design.decisions, verifiers: input.plan.verifiers.map((v) => v.identity) }),
    ...validateFindingTargets(lineage.analyses.filter((a) => a.inputs.every((i) => lineage.current.some((r) => sameArtifact(i, r)))),
      [input.product, input.requirements, input.architecture, input.program_design, input.slices, input.tasks, input.plan]), ...validateEvidenceIdentities(input.evidence),
    ...validateSpecBehavioralBindings(spec, input.review.revisions, input.review.analyses, input.behavioral.snapshots, input.behavioral.catalog, input.behavioral.environment)];
  if (!["verifying", "completed"].includes(spec.lifecycle.state)) blockers.push({ code: "spec-not-completable", subject: spec.lifecycle.state });
  for (const [kind, artifact] of [["product", input.product], ["program-design", input.program_design], ["slice-plan", input.slices], ["requirements", input.requirements], ["architecture", input.architecture], ["tasks", input.tasks], ["verification-plan", input.plan]] as const) {
    const current = spec.artifacts.current.find((s) => s.artifact.kind === kind);
    if (artifact.spec_id !== spec.id || current?.artifact.revision !== artifact.revision) blockers.push({ code: "canonical-artifact-mismatch", subject: kind });
    if (!current && planningKinds.some((k) => k === kind)) blockers.push({ code: `${kind}-missing`, subject: kind });
    if (current) {
      const reasons = artifactApplicability(lineage, current.artifact).reasons;
      blockers.push(...reasons);
      if (reasons.some((r) => r.code === "artifact-stale")) blockers.push({ code: `${kind}-stale`, subject: kind });
    }
    if (blockers.some((b) => b.subject === kind && ["required-analysis-missing", "artifact-approval-missing"].includes(b.code))) blockers.push({ code: `${kind}-blocked`, subject: kind });
  }
  const ids = [...input.product.outcomes.map((o) => o.id), ...input.product.success_criteria.map((s) => s.id),
    ...input.program_design.decisions.map((p) => p.id), ...input.slices.slices.map((s) => s.id), ...input.requirements.requirements.flatMap((r) => [r.id, ...r.acceptance_criteria.map((a) => a.id)]),
    ...input.architecture.decisions.map((d) => d.id), ...input.tasks.tasks.map((t) => t.identity.id), ...input.plan.verifiers.map((v) => v.identity.id),
    ...input.review.analyses.flatMap((a) => a.findings.map((f) => f.id))];
  for (const id of ids) {
    const entry = spec.identities.entries.find((e) => e.id === id);
    if (!entry || entry.retired_in !== undefined) blockers.push({ code: "identity-unregistered-or-retired", subject: id });
  }
  const binding = spec.run_binding, run = input.run;
  if (!binding || !run || binding.run !== run.id || binding.status !== "applicable" || binding.applicable_generation !== spec.generation)
    blockers.push({ code: "run-binding-inapplicable" });
  if (binding) {
    const snapshot = binding.snapshot;
    if (snapshot.spec_id !== spec.id || !exact(snapshot.decision_policy, spec.decision_policy.identity) ||
      !exact(snapshot.completion_policy, policy.identity) || !exact(snapshot.verification_profile, input.plan.profile) ||
      !sameSpecBehavioralBindings(snapshot.behavioral_profiles, spec.behavioral_profiles) ||
      !spec.artifacts.current.every((s) => snapshot.artifacts.some((a) => exact(a, s))) ||
      !snapshot.artifacts.every((s) => spec.artifacts.current.some((a) => exact(a, s))) ||
      !snapshot.approvals.every((a) => spec.approvals.includes(a)) ||
      !input.tasks.tasks.every((t) => snapshot.capability_policies.some((p) => exact(p, t.capability_policy))))
      blockers.push({ code: "run-snapshot-inapplicable" });
    blockers.push(...validatePinnedAssets(snapshot.behavioral_assets, input.behavioral.catalog, input.behavioral.environment));
  }
  if (input.workspace.consistency !== "stable") blockers.push({ code: "workspace-observation-unknown" });
  if (run) {
    if (!binding || !sameApprovedSnapshot(run.snapshot, binding.snapshot)) blockers.push({ code: "run-snapshot-inapplicable" });
    if (!["verifying", "completed"].includes(run.status)) blockers.push({ code: "run-not-quiescent" });
    if (run.claims.some((c) => c.status === "active") || run.authorities.some((a) => a.status === "active")) blockers.push({ code: "active-execution" });
    if (run.slices.some((s) => ["running", "verifying", "interrupted", "unknown"].includes(s.status))) blockers.push({ code: "unsafe-slice-state" });
    for (const state of run.tasks) {
      if (["claimed", "running", "verifying", "unknown", "interrupted"].includes(state.status)) blockers.push({ code: "unsafe-task-state", task: state.task.id, subject: state.status });
      if (run.tasks.filter((s) => s.task.id === state.task.id).length !== 1) blockers.push({ code: "duplicate-task-state", task: state.task.id });
      if (!input.tasks.tasks.some((t) => exact(t.identity, state.task))) blockers.push({ code: "task-state-definition-mismatch", task: state.task.id });
      if (state.run !== run.id || BigInt(state.run_generation) > BigInt(run.generation)) blockers.push({ code: "task-run-mismatch", task: state.task.id });
    }
  }
  const contexts = evidenceContexts(input);
  const applicableArtifacts = spec.artifacts.current.map((s) => s.artifact).filter((a) => artifactApplicability(lineage, a).applicable);
  for (const task of input.tasks.tasks) {
    const state = run?.tasks.find((s) => s.task.id === task.identity.id);
    if (task.required || state?.status === "completed") {
      for (const dependency of task.dependencies) if (run?.tasks.find((s) => s.task.id === dependency)?.status !== "completed")
        blockers.push({ code: "dependency-not-completed", task: task.identity.id, subject: dependency });
      blockers.push(...evaluateTaskCompletion({ task, state, evidence: input.evidence, evidence_contexts: contexts, applicable_artifacts: applicableArtifacts }));
      const attempts = input.attempts.filter((a) => a.id === state?.current_attempt);
      const attempt = attempts.length === 1 ? attempts[0] : undefined;
      const authority = run?.authorities.filter((a) => a.attempt === attempt?.id);
      if (attempt) blockers.push(...validateAttemptBehavior(attempt, task, input.behavioral.contexts, input.behavioral.catalog, input.behavioral.environment));
      if (!attempt || attempt.outcome !== "succeeded" || attempt.run !== run?.id || !run.attempts.includes(attempt.id) ||
        !exact(attempt.task, task.identity) || !exact(attempt.policy, task.capability_policy) || !exact(attempt.execution_profile, task.execution_profile) ||
        !binding || !sameApprovedSnapshot(attempt.snapshot, binding.snapshot) || authority?.length !== 1 || authority[0]!.status !== "published" ||
        !exact(authority[0]!.fence, attempt.fence) || BigInt(authority[0]!.generation) > BigInt(run.generation))
        blockers.push({ code: "task-attempt-inapplicable", task: task.identity.id });
    }
    blockers.push(...checkBackendRequirements(task.workspace.backend_requirements, input.backend));
  }
  for (const record of input.evidence) {
    const matches = contexts.filter((c) => c.task.id === record.task.id && c.verifier.identity.id === record.verifier.id && c.attempt.id === record.attempt);
    if (matches.length === 1 && matches[0]!.selected_evidence === record.id && Date.parse(record.ended_at) > Date.parse(input.workspace.at)) blockers.push({ code: "workspace-observation-too-old", subject: record.id });
  }
  for (const verifier of input.plan.required_verifiers) {
    const currentEvidence = input.evidence.filter((e) => e.verifier.id === verifier);
    const passing = currentEvidence.some((e) => contexts.some((c) => c.verifier.identity.id === verifier && evidencePasses(e, c)));
    if (!passing) {
      blockers.push({ code: "required-verification-missing", verifier });
      for (const e of currentEvidence) for (const c of contexts.filter((c) => c.task.id === e.task.id && c.verifier.identity.id === e.verifier.id))
        blockers.push(...evidenceApplicability(e, c).reasons);
    }
  }
  for (const slice of input.slices.slices.filter((s) => s.required || run?.slices.some((state) => state.slice === s.id && state.status === "completed")))
    blockers.push(...evaluateSliceCompletion({ slice, plan: input.slices, states: run?.slices ?? [], review: input.review,
      tasks: input.tasks, task_states: run?.tasks ?? [], verification: input.plan, evidence: input.evidence, evidence_contexts: contexts }));
  const traceability = buildTraceability({ product: input.product, program_design: input.program_design, slices: input.slices,
    artifacts: spec.artifacts.current.map((s) => s.artifact), requirements: input.requirements, architecture: input.architecture, tasks: input.tasks,
    plan: input.plan, evidence: input.evidence, evidence_contexts: contexts, policy });
  for (const issue of traceability.issues) if (!obligationWaived(input.review, issue.code, issue.subject ?? issue.requirement ?? "")) blockers.push(issue);
  for (const coverage of traceability.requirements.filter((r) => r.enforced)) {
    // A structural waiver doesn't fabricate observations for configured verifiers.
    for (const ac of coverage.acceptance_criteria) {
      if (!ac.required_verifiers.length) continue; // Structural gap is separately reported/waived above.
      if (!input.evidence.some((e) => e.acceptance_criteria.includes(ac.id as VerificationEvidence["acceptance_criteria"][number]) &&
        e.requirements.includes(coverage.requirement as VerificationEvidence["requirements"][number]) && ac.required_verifiers.includes(e.verifier.id) &&
        traceability.evidence.some((report) => report.id === e.id && report.passing)))
        blockers.push({ code: "acceptance-evidence-missing", requirement: coverage.requirement, subject: ac.id });
    }
  }
  if (policy.final_consistency_review_required) {
    const verifier = input.plan.verifiers.find((v) => v.identity.id === input.plan.final_consistency_review);
    if (!verifier || !["human-review", "agent-review"].includes(verifier.definition.kind) ||
      !input.evidence.some((e) => e.verifier.id === verifier.identity.id && contexts.some((c) => c.verifier.identity.id === verifier.identity.id && evidencePasses(e, c))))
      blockers.push({ code: "final-consistency-review-missing" });
  }
  return { complete: blockers.length === 0, blockers: stableIssues(blockers), traceability };
}
/** Pure completion transition proposal. Publication/generation advancement belongs to a later store. */
export function evaluateCompletionTransition(input: CompletionInput): { allowed: boolean; lifecycle?: SpecLifecycle; blockers: readonly DomainIssue[] } {
  const next: SpecLifecycle = { state: "completed" };
  const transition = checkLifecycleTransition(input.review.spec.mode, input.review.spec.lifecycle, next, input.review.spec.authoring_order);
  const completion = evaluateSpecCompletion(input);
  const blockers = stableIssues([...completion.blockers, ...(transition.ok ? [] : transition.issues)]);
  return blockers.length ? { allowed: false, blockers } : { allowed: true, lifecycle: next, blockers: [] };
}
