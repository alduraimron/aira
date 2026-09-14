import { z } from "zod";
import { analysisFindingIdSchema, artifactRevisionIdSchema, specIdSchema, requirementIdSchema, acceptanceCriterionIdSchema,
  productOutcomeIdSchema, successCriterionIdSchema, architectureDecisionIdSchema, programDesignDecisionIdSchema, sliceIdSchema, taskIdSchema } from "./ids";
import { planningKinds } from "./planning-kinds";
import { artifactReferenceSchema, sameArtifact, type ArtifactReference } from "./artifacts";
import { createdMetadataSchema, humanActorSchema, nonBlankSchema, timestampSchema, unique, canonical, type DeepReadonly } from "./primitives";

export const findingDispositionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unresolved") }),
  z.strictObject({ state: z.literal("dismissed"), rationale: nonBlankSchema, actor: humanActorSchema, at: timestampSchema }),
  z.strictObject({ state: z.literal("resolved"), rationale: nonBlankSchema, at: timestampSchema,
    artifact: artifactReferenceSchema.optional(),
    human_answer: z.strictObject({ actor: humanActorSchema, answer: nonBlankSchema }).optional(),
  }).refine((r) => r.artifact !== undefined || r.human_answer !== undefined, "resolution-reference-required"),
]);
const target = <const K extends string, T extends z.ZodType>(kind: K, artifact: string, id: T) => z.strictObject({
  kind: z.literal(kind), artifact: artifactReferenceSchema.refine((r) => r.kind === artifact), id,
});
export const findingEntityTargetSchema = z.union([
  target("product-outcome", "product", productOutcomeIdSchema), target("success-criterion", "product", successCriterionIdSchema),
  target("requirement", "requirements", requirementIdSchema), target("acceptance-criterion", "requirements", acceptanceCriterionIdSchema),
  target("architecture-decision", "architecture", architectureDecisionIdSchema), target("program-design-decision", "program-design", programDesignDecisionIdSchema),
  target("slice", "slice-plan", sliceIdSchema), target("task", "tasks", taskIdSchema),
]);
export const findingTargetSchema = z.union([
  z.strictObject({ kind: z.literal("artifact"), artifact: artifactReferenceSchema }), findingEntityTargetSchema,
  z.strictObject({ kind: z.literal("relationship"), references: z.array(findingEntityTargetSchema).min(2).refine((rs) => unique(rs.map(canonical))), description: nonBlankSchema }),
]);
export const productFindingCategories = ["unclear-user-problem", "solution-as-problem", "unclear-outcome", "missing-success-criteria",
  "non-measurable-success", "contradictory-goals", "missing-non-goals", "scope-explosion", "stakeholder-ambiguity", "product-assumption", "product-risk", "unnecessary-feature-scope"] as const;
export const architectureFindingCategories = ["uncovered-requirement", "boundary-violation", "ownership-ambiguity", "dependency-inversion-problem",
  "compatibility-risk", "migration-risk", "unsafe-data-ownership", "security-boundary-issue", "concurrency-flaw", "operational-observability-gap",
  "performance-risk", "deployment-mismatch", "unjustified-complexity", "repository-architecture-contradiction"] as const;
export const programDesignFindingCategories = ["architecture-contradiction", "incorrect-file-module-ownership", "layering-violation", "unnecessary-coupling",
  "unclear-symbol-responsibility", "missing-call-path", "missing-error-behavior", "missing-state-transition", "concurrency-gap", "testability-problem",
  "missing-test-plan", "oversized-module", "duplicate-responsibility", "unsafe-dependency", "unresolved-design-uncertainty", "implementation-ambiguity"] as const;
export const sliceFindingCategories = ["horizontal-layering", "no-end-to-end-outcome", "unverifiable-slice", "overly-large-slice", "trivial-slice",
  "requirement-coverage-gap", "cross-slice-coupling", "cyclic-dependency", "unnecessary-sequencing", "risky-shared-state-overlap", "incoherent-system-state",
  "unnecessary-slice-tasks", "unrelated-slice-goals"] as const;
export const analysisFindingSchema = z.strictObject({
  id: analysisFindingIdSchema,
  category: z.enum(["ambiguity", "contradiction", "missing-case", "concurrency", "security", "compatibility", "observability",
    "measurability", "architecture", "verification", "migration", "assumption", "other",
    ...productFindingCategories, ...architectureFindingCategories, ...programDesignFindingCategories, ...sliceFindingCategories]),
  custom_category: nonBlankSchema.optional(), severity: z.enum(["info", "warning", "blocker"]),
  title: nonBlankSchema, description: nonBlankSchema, subjects: z.array(artifactReferenceSchema).min(1),
  targets: z.array(findingTargetSchema).min(1).refine((ts) => unique(ts.map(canonical))), disposition: findingDispositionSchema,
}).refine((f) => (f.category === "other") === (f.custom_category !== undefined), "custom-category-required-only-for-other")
  .refine((f) => f.targets.flatMap((t) => "references" in t ? t.references.map((r) => r.artifact) : [t.artifact])
    .every((a) => f.subjects.some((s) => sameArtifact(a, s))), "finding-target-outside-subjects");
export const analysisSchema = z.strictObject({
  schema: z.literal("aira.dev/analysis/v2"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  phase: z.enum([...planningKinds, "consistency", "final-consistency"]),
  inputs: z.array(artifactReferenceSchema).min(1), created: createdMetadataSchema,
  outcome: z.enum(["consistent", "inconsistent", "unknown"]), findings: z.array(analysisFindingSchema),
}).refine((a) => unique(a.findings.map((f) => f.id)) && unique(a.inputs.map((i) => i.revision)) &&
  a.findings.every((f) => f.subjects.every((s) => a.inputs.some((i) => sameArtifact(i, s)))), "invalid-analysis-bindings");
export type AnalysisFinding = DeepReadonly<z.infer<typeof analysisFindingSchema>>;
export type Analysis = DeepReadonly<z.infer<typeof analysisSchema>>;
export function hasBlockingFindings(findings: readonly AnalysisFinding[]): boolean {
  return findings.some((f) => f.severity === "blocker" && f.disposition.state === "unresolved");
}
export function analysisMatches(analysis: Analysis, inputs: readonly ArtifactReference[]): boolean {
  return analysis.inputs.length === inputs.length && inputs.every((i) => analysis.inputs.some((a) => sameArtifact(a, i)));
}
