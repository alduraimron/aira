import { z } from "zod";
import { canonicalBytes } from "../canonical-json";
import { artifactReferenceSchema } from "../spec/domain/artifacts";
import { attemptIdSchema, evidenceIdSchema, operationIdSchema } from "../spec/domain/ids";
import { planningKinds } from "../spec/domain/planning-kinds";
import { canonical, compareText, exact, type DeepReadonly } from "../spec/domain/primitives";
import { steeringEnforcementBindingSchema } from "./authority";
import { steeringPhaseSchema, steeringScopeSchema } from "./applicability";
import { steeringRevisionReferenceSchema, steeringSemanticKeySchema } from "./ids";
import { freezeResolution, sorted, steeringRuleReferenceSchema, type SteeringRuleReference } from "./resolution-contract";
import { steeringProjectNamespaceSchema } from "./schema";
import { steeringScopesDisjoint } from "./scope";
import {
  steeringSnapshotReference,
  steeringSnapshotReferenceSchema,
  steeringSnapshotSchema,
  validateSteeringSnapshot,
  type SteeringSnapshot,
} from "./snapshot";

export const STEERING_DEPENDENCY_SCHEMA = "aira.dev/steering-dependency/v1" as const;

export const steeringDependencySubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("planning-artifact"),
    artifact: artifactReferenceSchema.refine((artifact) => planningKinds.includes(artifact.kind as typeof planningKinds[number]),
      "steering-dependency-planning-artifact-required"),
  }),
  z.strictObject({ kind: z.literal("implementation-attempt"), attempt: attemptIdSchema }),
  z.strictObject({ kind: z.literal("verification-evidence"), evidence: evidenceIdSchema }),
  z.strictObject({ kind: z.literal("review-operation"), operation: operationIdSchema }),
]);

const canonicalSet = (values: readonly unknown[]): boolean => values.every((value, index) =>
  index === 0 || compareText(canonical(values[index - 1]), canonical(value)) < 0);
export const steeringDeclaredDependencySchema = z.strictObject({
  mode: z.literal("declared"),
  resources: z.array(steeringRevisionReferenceSchema).refine(canonicalSet, "noncanonical-steering-dependency-resources"),
  semantic_keys: z.array(steeringSemanticKeySchema).refine((values) => values.every((value, index) =>
    index === 0 || compareText(values[index - 1]!, value) < 0), "noncanonical-steering-dependency-semantic-keys"),
  rules: z.array(steeringRuleReferenceSchema).refine(canonicalSet, "noncanonical-steering-dependency-rules"),
  enforcement: z.array(steeringEnforcementBindingSchema).refine(canonicalSet, "noncanonical-steering-dependency-enforcement"),
}).refine((dependency) => dependency.resources.length + dependency.semantic_keys.length + dependency.rules.length +
  dependency.enforcement.length > 0, "steering-dependency-observation-required");
export const steeringDependencyModeSchema = z.union([
  z.strictObject({ mode: z.literal("whole-snapshot") }),
  steeringDeclaredDependencySchema,
]);
export const steeringDependencySchema = z.strictObject({
  schema: z.literal(STEERING_DEPENDENCY_SCHEMA),
  project: steeringProjectNamespaceSchema,
  snapshot: steeringSnapshotReferenceSchema,
  phase: steeringPhaseSchema,
  subject: steeringDependencySubjectSchema,
  relevance: z.strictObject({ scope: steeringScopeSchema }).optional(),
  dependency: steeringDependencyModeSchema,
});

export type SteeringDependencySubject = DeepReadonly<z.infer<typeof steeringDependencySubjectSchema>>;
export type SteeringDeclaredDependency = DeepReadonly<z.infer<typeof steeringDeclaredDependencySchema>>;
export type SteeringDependency = DeepReadonly<z.infer<typeof steeringDependencySchema>>;
export type SteeringDependencyDeclaration = DeepReadonly<Omit<z.input<typeof steeringDependencySchema>, "schema" | "project" | "snapshot">>;

export const steeringDependencyIssueCodes = [
  "steering-dependency-input-invalid",
  "steering-dependency-snapshot-mismatch",
  "steering-dependency-phase-mismatch",
  "steering-dependency-subject-phase-mismatch",
  "steering-dependency-required-input-missing",
  "steering-dependency-observation-not-in-snapshot",
  "steering-dependency-relevance-unproven",
] as const;
export type SteeringDependencyIssueCode = typeof steeringDependencyIssueCodes[number];
export interface SteeringDependencyIssue {
  readonly code: SteeringDependencyIssueCode;
  readonly subject?: string;
  readonly rule?: SteeringRuleReference;
}
export type SteeringDependencyBuildResult =
  | { readonly ok: true; readonly value: SteeringDependency }
  | { readonly ok: false; readonly issues: readonly SteeringDependencyIssue[] };

const stableDependencyIssues = (issues: readonly SteeringDependencyIssue[]): SteeringDependencyIssue[] =>
  [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
const planningPhase = {
  product: "product",
  requirements: "requirements",
  architecture: "architecture",
  "program-design": "program-design",
  "slice-plan": "slice-planning",
  tasks: "task-planning",
} as const;

function relationshipIssues(dependency: SteeringDependency, snapshot: SteeringSnapshot): SteeringDependencyIssue[] {
  const issues: SteeringDependencyIssue[] = [];
  if (!exact(dependency.snapshot, steeringSnapshotReference(snapshot)) || dependency.project !== snapshot.semantic.project)
    issues.push({ code: "steering-dependency-snapshot-mismatch", subject: dependency.snapshot.id });
  if (dependency.phase !== snapshot.semantic.selectors.action.phase)
    issues.push({ code: "steering-dependency-phase-mismatch", subject: dependency.phase });
  if (dependency.subject.kind === "planning-artifact" &&
    planningPhase[dependency.subject.artifact.kind as keyof typeof planningPhase] !== dependency.phase)
    issues.push({ code: "steering-dependency-subject-phase-mismatch", subject: dependency.subject.artifact.kind });
  if (dependency.subject.kind === "implementation-attempt" && dependency.phase !== "implementation")
    issues.push({ code: "steering-dependency-subject-phase-mismatch", subject: dependency.subject.kind });
  if (dependency.subject.kind === "verification-evidence" && dependency.phase !== "verification")
    issues.push({ code: "steering-dependency-subject-phase-mismatch", subject: dependency.subject.kind });
  if (dependency.subject.kind === "review-operation" && dependency.phase !== "review")
    issues.push({ code: "steering-dependency-subject-phase-mismatch", subject: dependency.subject.kind });

  const relevance = dependency.relevance?.scope;
  const overlaps = (scope: SteeringSnapshot["semantic"]["resources"][number]["scope"]): boolean =>
    relevance === undefined || !steeringScopesDisjoint(scope, relevance);
  if (relevance !== undefined && snapshot.semantic.resources.length > 0 &&
    !snapshot.semantic.resources.some((resource) => overlaps(resource.scope)))
    issues.push({ code: "steering-dependency-relevance-unproven", subject: "scope" });

  if (dependency.dependency.mode === "declared") {
    const observations = dependency.dependency;
    for (const resource of observations.resources) if (!snapshot.semantic.resources.some((entry) =>
      exact(entry.revision.identity, resource) && overlaps(entry.scope)))
      issues.push({ code: "steering-dependency-observation-not-in-snapshot", subject: `${resource.id}@${resource.revision}` });
    for (const rule of observations.rules) if (!snapshot.semantic.effective_rules.some((effective) =>
      effective.contributors.some((contributor) => exact(contributor.resource, rule.resource) && contributor.rule === rule.rule) &&
      effective.regions.some((region) => exact(region.source, rule) && overlaps(region.scope))))
      issues.push({ code: "steering-dependency-observation-not-in-snapshot", subject: rule.rule, rule });
    for (const key of observations.semantic_keys) if (!snapshot.semantic.effective_rules.some((effective) =>
      effective.semantics.key === key && effective.regions.some((region) => overlaps(region.scope))))
      issues.push({ code: "steering-dependency-observation-not-in-snapshot", subject: key });
    for (const binding of observations.enforcement) if (!snapshot.semantic.enforcement.some((entry) =>
      exact(entry.binding, binding) && entry.sources.some((source) => overlaps(source.scope))))
      issues.push({ code: "steering-dependency-observation-not-in-snapshot", subject: canonical(binding) });
  }
  return stableDependencyIssues(issues);
}

export function validateSteeringDependency(value: unknown, snapshot?: SteeringSnapshot): readonly SteeringDependencyIssue[] {
  const parsed = steeringDependencySchema.safeParse(value);
  if (!parsed.success) return stableDependencyIssues(parsed.error.issues.map((issue) => ({
    code: issue.message === "steering-dependency-observation-required" ?
      "steering-dependency-required-input-missing" : "steering-dependency-input-invalid",
    ...(issue.path.length ? { subject: issue.path.map(String).join(".") } : {}),
  })));
  if (snapshot === undefined) return [];
  if (!steeringSnapshotSchema.safeParse(snapshot).success || validateSteeringSnapshot(snapshot).length)
    return [{ code: "steering-dependency-required-input-missing", subject: "snapshot" }];
  return relationshipIssues(parsed.data as SteeringDependency, snapshot);
}

/** Build a detached immutable sidecar binding without modifying the governed artifact/action. */
export function bindSteeringDependency(
  snapshot: SteeringSnapshot,
  declaration: SteeringDependencyDeclaration,
): SteeringDependencyBuildResult {
  if (!steeringSnapshotSchema.safeParse(snapshot).success || validateSteeringSnapshot(snapshot).length)
    return { ok: false, issues: [{ code: "steering-dependency-required-input-missing", subject: "snapshot" }] };
  const mode = declaration.dependency.mode === "declared" ? {
    mode: "declared" as const,
    resources: sorted(declaration.dependency.resources),
    semantic_keys: [...declaration.dependency.semantic_keys].sort(compareText),
    rules: sorted(declaration.dependency.rules),
    enforcement: sorted(declaration.dependency.enforcement),
  } : { mode: "whole-snapshot" as const };
  const parsed = steeringDependencySchema.safeParse({
    schema: STEERING_DEPENDENCY_SCHEMA,
    project: snapshot.semantic.project,
    snapshot: steeringSnapshotReference(snapshot),
    phase: declaration.phase,
    subject: declaration.subject,
    ...(declaration.relevance === undefined ? {} : { relevance: declaration.relevance }),
    dependency: mode,
  });
  if (!parsed.success) return { ok: false, issues: stableDependencyIssues(parsed.error.issues.map((issue) => ({
    code: issue.message === "steering-dependency-observation-required" ?
      "steering-dependency-required-input-missing" : "steering-dependency-input-invalid",
    ...(issue.path.length ? { subject: issue.path.map(String).join(".") } : {}),
  }))) };
  const issues = relationshipIssues(parsed.data as SteeringDependency, snapshot);
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: freezeResolution(JSON.parse(new TextDecoder().decode(canonicalBytes(parsed.data))) as SteeringDependency) };
}
