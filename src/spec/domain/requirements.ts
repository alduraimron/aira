import { z } from "zod";
import { acceptanceCriterionIdSchema, artifactRevisionIdSchema, requirementIdSchema, specIdSchema } from "./ids";
import { nonBlankSchema, stableIssues, unique, type DomainIssue, type DeepReadonly } from "./primitives";

const behavior = { id: acceptanceCriterionIdSchema, expected_behavior: nonBlankSchema };
export const acceptanceCriterionSchema = z.discriminatedUnion("form", [
  z.strictObject({ ...behavior, form: z.literal("ubiquitous") }),
  z.strictObject({ ...behavior, form: z.literal("event-driven"), trigger: nonBlankSchema }),
  z.strictObject({ ...behavior, form: z.literal("state-driven"), condition: nonBlankSchema }),
  z.strictObject({ ...behavior, form: z.literal("unwanted-behavior"), trigger: nonBlankSchema }),
  z.strictObject({ ...behavior, form: z.literal("optional-feature"), feature: nonBlankSchema }),
  z.strictObject({ ...behavior, form: z.literal("complex"), conditions: z.array(nonBlankSchema).min(1), trigger: nonBlankSchema.optional() }),
  z.strictObject({ ...behavior, form: z.literal("freeform"), text: nonBlankSchema }),
]);
export const requirementSchema = z.strictObject({
  id: requirementIdSchema,
  type: z.enum(["functional", "non-functional", "constraint", "security", "compatibility", "operability"]),
  title: nonBlankSchema, priority: z.enum(["must", "should", "could"]), statement: nonBlankSchema,
  rationale: nonBlankSchema.optional(), assumptions: z.array(nonBlankSchema).optional(),
  dependencies: z.array(requirementIdSchema),
  measurable_target: z.strictObject({ metric: nonBlankSchema, operator: z.enum(["lt", "lte", "eq", "gte", "gt", "matches"]),
    value: z.union([z.number().finite(), nonBlankSchema]), unit: nonBlankSchema.optional(), conditions: nonBlankSchema.optional() }).optional(),
  acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
}).refine((r) => unique(r.dependencies) && !r.dependencies.includes(r.id) &&
  unique(r.acceptance_criteria.map((a) => a.id)) &&
  r.acceptance_criteria.every((a) => a.id.split(".")[0] === r.id), "invalid-requirement-identities");
export const requirementsSchema = z.strictObject({
  schema: z.literal("aira.dev/requirements/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  requirements: z.array(requirementSchema).min(1),
}).refine((r) => validateRequirements(r.requirements).length === 0, "invalid-requirement-references");
export type Requirement = DeepReadonly<z.infer<typeof requirementSchema>>;
export type AcceptanceCriterion = DeepReadonly<z.infer<typeof acceptanceCriterionSchema>>;
export type Requirements = DeepReadonly<z.infer<typeof requirementsSchema>>;
export function validateRequirements(requirements: readonly Requirement[]): DomainIssue[] {
  const ids = requirements.map((r) => r.id), issues: DomainIssue[] = [];
  for (const r of requirements) {
    if (ids.filter((id) => id === r.id).length > 1) issues.push({ code: "duplicate-requirement", requirement: r.id });
    for (const dep of r.dependencies) if (!ids.includes(dep))
      issues.push({ code: "unknown-requirement-dependency", requirement: r.id, subject: dep });
  }
  return stableIssues(issues);
}
