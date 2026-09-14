import { z } from "zod";
import { artifactRevisionIdSchema, productOutcomeIdSchema, successCriterionIdSchema, specIdSchema } from "./ids";
import { nonBlankSchema, stableIssues, unique, type DeepReadonly, type DomainIssue } from "./primitives";

export const productRiskSchema = z.strictObject({ description: nonBlankSchema, mitigation: nonBlankSchema.optional() });
export const productOutcomeSchema = z.strictObject({ id: productOutcomeIdSchema, statement: nonBlankSchema });
export const successCriterionSchema = z.strictObject({
  id: successCriterionIdSchema, outcomes: z.array(productOutcomeIdSchema).refine(unique), statement: nonBlankSchema,
  measurement: nonBlankSchema.optional(),
});
export const productDefinitionSchema = z.strictObject({
  schema: z.literal("aira.dev/product/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  problem: nonBlankSchema, current_pain_or_opportunity: nonBlankSchema,
  stakeholders: z.array(z.strictObject({ name: nonBlankSchema, role: z.enum(["user", "actor", "stakeholder"]), need: nonBlankSchema })).min(1),
  outcomes: z.array(productOutcomeSchema).min(1), success_criteria: z.array(successCriterionSchema).min(1),
  non_goals: z.array(nonBlankSchema), assumptions: z.array(nonBlankSchema), constraints: z.array(nonBlankSchema),
  risks: z.array(productRiskSchema), unresolved_questions: z.array(nonBlankSchema),
  external_business_constraints: z.array(nonBlankSchema).optional(),
}).superRefine((p, ctx) => {
  if (!unique(p.outcomes.map((o) => o.id))) ctx.addIssue({ code: "custom", message: "duplicate-product-outcome" });
  if (!unique(p.success_criteria.map((s) => s.id))) ctx.addIssue({ code: "custom", message: "duplicate-success-criterion" });
  for (const criterion of p.success_criteria) for (const id of criterion.outcomes)
    if (!p.outcomes.some((o) => o.id === id)) ctx.addIssue({ code: "custom", message: `unknown-success-outcome:${criterion.id}:${id}` });
});
export type ProductDefinition = DeepReadonly<z.infer<typeof productDefinitionSchema>>;
export type ProductOutcome = DeepReadonly<z.infer<typeof productOutcomeSchema>>;
export type SuccessCriterion = DeepReadonly<z.infer<typeof successCriterionSchema>>;
export function validateProduct(value: unknown): DomainIssue[] {
  const parsed = productDefinitionSchema.safeParse(value);
  return parsed.success ? [] : stableIssues(parsed.error.issues.map((i) => ({ code: "invalid-product", subject: i.message })));
}
