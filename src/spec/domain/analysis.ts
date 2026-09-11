import { z } from "zod";
import { analysisFindingIdSchema, artifactRevisionIdSchema, specIdSchema } from "./ids";
import { artifactReferenceSchema, sameArtifact, type ArtifactReference } from "./artifacts";
import { createdMetadataSchema, humanActorSchema, nonBlankSchema, timestampSchema, unique, type DeepReadonly } from "./primitives";

export const findingDispositionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unresolved") }),
  z.strictObject({ state: z.literal("dismissed"), rationale: nonBlankSchema, actor: humanActorSchema, at: timestampSchema }),
  z.strictObject({ state: z.literal("resolved"), rationale: nonBlankSchema, at: timestampSchema,
    artifact: artifactReferenceSchema.optional(),
    human_answer: z.strictObject({ actor: humanActorSchema, answer: nonBlankSchema }).optional(),
  }).refine((r) => r.artifact !== undefined || r.human_answer !== undefined, "resolution-reference-required"),
]);
export const analysisFindingSchema = z.strictObject({
  id: analysisFindingIdSchema,
  category: z.enum(["ambiguity", "contradiction", "missing-case", "concurrency", "security", "compatibility", "observability",
    "measurability", "architecture", "verification", "migration", "assumption", "other"]),
  custom_category: nonBlankSchema.optional(), severity: z.enum(["info", "warning", "blocker"]),
  title: nonBlankSchema, description: nonBlankSchema, subjects: z.array(artifactReferenceSchema).min(1),
  disposition: findingDispositionSchema,
}).refine((f) => (f.category === "other") === (f.custom_category !== undefined), "custom-category-required-only-for-other");
export const analysisSchema = z.strictObject({
  schema: z.literal("aira.dev/analysis/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  phase: z.enum(["requirements", "design", "tasks", "consistency", "final-consistency"]),
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
