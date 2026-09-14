import { z } from "zod";
import { sliceIdSchema, artifactRevisionIdSchema, specIdSchema, productOutcomeIdSchema, requirementIdSchema,
  acceptanceCriterionIdSchema, architectureDecisionIdSchema, programDesignDecisionIdSchema, taskIdSchema, verifierIdSchema, type SliceId } from "./ids";
import { canonical, compareText, cyclicComponents, exact, nonBlankSchema, policyReferenceSchema, stableIssues, unique, type DeepReadonly, type DomainIssue } from "./primitives";
import { productRiskSchema, type ProductDefinition } from "./product";
import { requirementReferenceIssues, type SystemArchitecture } from "./architecture";
import type { ProgramDesign } from "./program-design";
import type { Requirements } from "./requirements";
import type { Tasks } from "../../tasks/types";
import type { TaskExecutionState } from "../../execution/types";
import { sliceExecutionStateSchema, type SliceExecutionState } from "./slice-state";
import { sameArtifact } from "./artifacts";
import { evaluateSpecGates, type SpecReviewContext } from "./review";
import { evidencePasses, type EvidenceContext } from "../../verification/applicability";
import type { VerificationEvidence, VerificationPlan } from "../../verification/types";
import { evaluateTaskCompletion } from "../../tasks/completion";
import { artifactApplicability } from "./lineage";
import { lineageContext } from "./review";
import { specSchema } from "./schema";

export const verticalSliceSchema = z.strictObject({
  id: sliceIdSchema, kind: z.enum(["implementation", "non-implementation"]), title: nonBlankSchema,
  intent: nonBlankSchema, outcome: nonBlankSchema, required: z.boolean(),
  product_outcomes: z.array(productOutcomeIdSchema), requirements: z.array(requirementIdSchema), acceptance_criteria: z.array(acceptanceCriterionIdSchema),
  architecture_decisions: z.array(architectureDecisionIdSchema), program_design_decisions: z.array(programDesignDecisionIdSchema),
  dependencies: z.array(sliceIdSchema), tasks: z.array(taskIdSchema), required_verifiers: z.array(verifierIdSchema).min(1),
  completion: z.array(z.strictObject({ id: nonBlankSchema, predicate: nonBlankSchema, verifier: verifierIdSchema })).min(1),
  demonstration: z.array(nonBlankSchema).min(1), risks: z.array(productRiskSchema),
  checkpoint: z.strictObject({ policy: policyReferenceSchema, verifier: verifierIdSchema }).optional(),
  non_implementation: z.strictObject({ justification: nonBlankSchema, policy: policyReferenceSchema }).optional(),
  rollout_migration: nonBlankSchema.optional(),
}).refine((s) => [s.product_outcomes, s.requirements, s.acceptance_criteria, s.architecture_decisions, s.program_design_decisions,
  s.dependencies, s.tasks, s.required_verifiers].every(unique) && unique(s.completion.map((c) => c.id)) &&
  s.completion.every((c) => s.required_verifiers.includes(c.verifier)) && (!s.checkpoint || s.required_verifiers.includes(s.checkpoint.verifier)) &&
  (s.kind === "implementation" ? s.tasks.length > 0 && !s.non_implementation : !!s.non_implementation), "invalid-slice-obligations");
export const slicePlanDocumentSchema = z.strictObject({
  schema: z.literal("aira.dev/slice-plan/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  slices: z.array(verticalSliceSchema).min(1),
});
export type VerticalSlice = DeepReadonly<z.infer<typeof verticalSliceSchema>>;
export function sliceGraphIssues(slices: readonly VerticalSlice[]): DomainIssue[] {
  const ids = slices.map((s) => s.id), edges = new Map<string, string[]>(), issues: DomainIssue[] = [];
  for (const slice of slices) {
    if (ids.filter((id) => id === slice.id).length !== 1) issues.push({ code: "duplicate-slice", subject: slice.id });
    edges.set(slice.id, [...new Set([...(edges.get(slice.id) ?? []), ...slice.dependencies])]);
    for (const dep of slice.dependencies) {
      if (dep === slice.id) issues.push({ code: "slice-self-dependency", subject: slice.id });
      if (!ids.includes(dep)) issues.push({ code: "unknown-slice-dependency", subject: slice.id, related: [dep] });
    }
  }
  for (const cycle of cyclicComponents(edges)) issues.push({ code: "slice-cycle", related: cycle });
  return stableIssues(issues);
}
export const slicePlanSchema = slicePlanDocumentSchema.superRefine((p, ctx) => {
  for (const issue of sliceGraphIssues(p.slices)) ctx.addIssue({ code: "custom", message: canonical(issue) });
});
export type SlicePlan = DeepReadonly<z.infer<typeof slicePlanSchema>>;
export function validateSliceDAG(value: unknown): DomainIssue[] {
  const result = slicePlanDocumentSchema.safeParse(value);
  return result.success ? sliceGraphIssues(result.data.slices) : [{ code: "invalid-slice-plan" }];
}
export function slicePredecessors(plan: SlicePlan, id: SliceId): SliceId[] {
  const visited = new Set<SliceId>(), todo = [...(plan.slices.find((s) => s.id === id)?.dependencies ?? [])];
  while (todo.length) {
    const next = todo.pop()!;
    if (visited.has(next)) continue;
    visited.add(next); todo.push(...(plan.slices.find((s) => s.id === next)?.dependencies ?? []));
  }
  return [...visited].sort(compareText);
}
export function validateTaskSliceConsistency(plan: SlicePlan, tasks: Tasks): DomainIssue[] {
  const issues = validateSliceDAG(plan);
  if (plan.spec_id !== tasks.spec_id) issues.push({ code: "cross-spec-task-slice" });
  for (const slice of plan.slices) for (const id of slice.tasks) if (!tasks.tasks.some((t) => t.identity.id === id))
    issues.push({ code: "unknown-slice-task", subject: slice.id, task: id });
  for (const task of tasks.tasks) {
    const owners = plan.slices.filter((s) => s.tasks.includes(task.identity.id));
    if (owners.length !== 1) issues.push({ code: owners.length ? "task-multiple-slices" : "task-slice-missing", task: task.identity.id });
    const owner = owners[0];
    if (!owner || owner.id !== task.slice) issues.push({ code: "task-slice-owner-mismatch", task: task.identity.id });
    if (!owner) continue;
    for (const dep of task.dependencies) {
      const predecessor = tasks.tasks.find((t) => t.identity.id === dep);
      if (predecessor && predecessor.slice !== owner.id && !slicePredecessors(plan, owner.id).includes(predecessor.slice))
        issues.push({ code: "cross-slice-dependency-order", task: task.identity.id, subject: owner.id, related: [dep, predecessor.slice] });
    }
  }
  return stableIssues(issues);
}
export function validateSliceReferences(plan: SlicePlan, product: ProductDefinition, requirements: Requirements,
  architecture: SystemArchitecture, program: ProgramDesign, verification?: VerificationPlan): DomainIssue[] {
  const issues = validateSliceDAG(plan);
  if ([product, requirements, architecture, program, ...(verification ? [verification] : [])].some((a) => a.spec_id !== plan.spec_id))
    issues.push({ code: "cross-spec-slice-plan" });
  for (const s of plan.slices) {
    issues.push(...requirementReferenceIssues(s.id, s.requirements, s.acceptance_criteria, requirements, "slice"));
    for (const [refs, known, code] of [
      [s.product_outcomes, product.outcomes.map((o) => o.id), "unknown-slice-product-outcome"],
      [s.architecture_decisions, architecture.decisions.map((a) => a.id), "unknown-slice-architecture"],
      [s.program_design_decisions, program.decisions.map((p) => p.id), "unknown-slice-program-design"],
    ] as const) for (const id of refs) if (!(known as readonly string[]).includes(id)) issues.push({ code, subject: s.id, related: [id] });
    if (verification) {
      for (const id of s.required_verifiers) if (!verification.verifiers.some((v) => v.identity.id === id && v.slices.includes(s.id)))
        issues.push({ code: "slice-verifier-link-missing", subject: s.id, verifier: id });
      if (s.checkpoint && !verification.verifiers.some((v) => v.identity.id === s.checkpoint!.verifier && v.definition.kind === "human-review" && exact(v.policy, s.checkpoint!.policy)))
        issues.push({ code: "slice-checkpoint-policy-mismatch", subject: s.id });
    }
  }
  return stableIssues(issues);
}
export interface SliceReadinessInput {
  readonly plan: SlicePlan; readonly states: readonly SliceExecutionState[]; readonly review: SpecReviewContext;
}
export function sliceStateIssues(input: SliceReadinessInput): DomainIssue[] {
  const current = input.review.spec.artifacts.current.find((s) => s.artifact.kind === "slice-plan")?.artifact;
  const issues: DomainIssue[] = [];
  if (!specSchema.safeParse(input.review.spec).success) issues.push({ code: "invalid-domain-contract", subject: "spec" });
  if (!current || input.plan.revision !== current.revision || input.plan.spec_id !== input.review.spec.id) issues.push({ code: "slice-plan-inapplicable" });
  const binding = input.review.spec.run_binding;
  if (binding && (binding.status !== "applicable" || binding.applicable_generation !== input.review.spec.generation)) issues.push({ code: "slice-run-inapplicable" });
  for (const state of input.states) {
    if (!sliceExecutionStateSchema.safeParse(state).success || !current || !sameArtifact(state.plan, current) ||
      !input.plan.slices.some((s) => s.id === state.slice)) issues.push({ code: "slice-state-definition-mismatch", subject: state.slice });
    if (input.states.filter((s) => s.slice === state.slice).length !== 1) issues.push({ code: "duplicate-slice-state", subject: state.slice });
    if (!binding || binding.run !== state.run || binding.status !== "applicable" || binding.applicable_generation !== input.review.spec.generation)
      issues.push({ code: "slice-run-inapplicable", subject: state.slice });
  }
  return stableIssues(issues);
}
/** Set-based pure eligibility only. No activation, claim or scheduler side effects. */
export function sliceReadiness(input: SliceReadinessInput) {
  const issues = stableIssues([...validateSliceDAG(input.plan), ...sliceStateIssues(input), ...evaluateSpecGates(input.review)]);
  if (!["ready", "implementing", "verifying"].includes(input.review.spec.lifecycle.state)) issues.push({ code: "spec-not-executable" });
  const ready: SliceId[] = [], active: SliceId[] = [], blocked: { slice: SliceId; reasons: readonly DomainIssue[] }[] = [];
  for (const slice of [...input.plan.slices].sort((a, b) => compareText(a.id, b.id))) {
    const state = input.states.find((s) => s.slice === slice.id);
    if (state && ["completed", "skipped", "cancelled", "failed"].includes(state.status)) continue;
    const reasons = [...issues];
    for (const dep of slicePredecessors(input.plan, slice.id)) if (input.states.filter((s) => s.slice === dep && s.status === "completed").length !== 1)
      reasons.push({ code: "slice-predecessor-not-completed", subject: slice.id, related: [dep] });
    if (state && ["blocked", "interrupted", "unknown"].includes(state.status)) reasons.push({ code: "slice-recovery-required", subject: slice.id });
    if (reasons.length) blocked.push({ slice: slice.id, reasons: stableIssues(reasons) });
    else if (state && ["running", "verifying"].includes(state.status)) active.push(slice.id);
    else ready.push(slice.id);
  }
  return { ready, active, blocked, issues: stableIssues(issues) };
}
export interface SliceCompletionInput extends SliceReadinessInput {
  readonly slice: VerticalSlice; readonly tasks: Tasks; readonly task_states: readonly TaskExecutionState[];
  readonly verification: VerificationPlan; readonly evidence: readonly VerificationEvidence[]; readonly evidence_contexts: readonly EvidenceContext[];
}
/** Worker success is never a completion predicate. Each predicate/checkpoint pins a verifier. */
export function evaluateSliceCompletion(input: SliceCompletionInput): DomainIssue[] {
  const { slice } = input, state = input.states.find((s) => s.slice === slice.id);
  const issues: DomainIssue[] = [...evaluateSpecGates(input.review), ...sliceStateIssues(input), ...validateTaskSliceConsistency(input.plan, input.tasks)];
  if (!state || state.status !== "completed") issues.push({ code: "slice-not-completed", subject: slice.id });
  if (!input.plan.slices.some((s) => exact(s, slice))) issues.push({ code: "slice-definition-mismatch", subject: slice.id });
  for (const dep of slicePredecessors(input.plan, slice.id)) if (input.states.find((s) => s.slice === dep)?.status !== "completed")
    issues.push({ code: "slice-predecessor-not-completed", subject: slice.id, related: [dep] });
  for (const task of input.tasks.tasks.filter((t) => slice.tasks.includes(t.identity.id) && t.required)) {
    const states = input.task_states.filter((s) => exact(s.task, task.identity));
    if (states.length !== 1 || states[0]!.status !== "completed") issues.push({ code: "slice-task-not-completed", subject: slice.id, task: task.identity.id });
    if (states[0]?.run !== state?.run) issues.push({ code: "slice-task-run-mismatch", subject: slice.id, task: task.identity.id });
    issues.push(...evaluateTaskCompletion({ task, state: states.length === 1 ? states[0] : undefined, evidence: input.evidence, evidence_contexts: input.evidence_contexts,
      applicable_artifacts: input.review.spec.artifacts.current.map((s) => s.artifact).filter((a) => artifactApplicability(lineageContext(input.review), a).applicable) }));
  }
  const required = [...new Set([...slice.required_verifiers, ...slice.completion.map((c) => c.verifier), ...(slice.checkpoint ? [slice.checkpoint.verifier] : [])])];
  for (const id of required) {
    const verifier = input.verification.verifiers.find((v) => v.identity.id === id && v.slices.includes(slice.id));
    const selection = state?.current_evidence.find((e) => e.verifier === id);
    const record = input.evidence.find((e) => e.id === selection?.evidence && e.slices.includes(slice.id) && e.verifier.id === id);
    const contexts = input.evidence_contexts.filter((c) => c.selected_evidence === record?.id && c.verifier.identity.id === id);
    if (!verifier || !record || contexts.length !== 1 || !evidencePasses(record, contexts[0]!))
      issues.push({ code: "slice-verification-missing", subject: slice.id, verifier: id });
    if (slice.checkpoint?.verifier === id && (!verifier || verifier.definition.kind !== "human-review" || !exact(verifier.policy, slice.checkpoint.policy)))
      issues.push({ code: "slice-checkpoint-policy-mismatch", subject: slice.id });
  }
  return stableIssues(issues);
}
