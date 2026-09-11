import { z } from "zod";
import { acceptanceCriterionIdSchema, artifactRevisionIdSchema, designDecisionIdSchema, requirementIdSchema, specIdSchema } from "./ids";
import { nonBlankSchema, unique, stableIssues, type DomainIssue, type DeepReadonly } from "./primitives";
import type { Requirements } from "./requirements";

export const designDecisionSchema = z.strictObject({
  id: designDecisionIdSchema, title: nonBlankSchema, description: nonBlankSchema,
  requirements: z.array(requirementIdSchema), acceptance_criteria: z.array(acceptanceCriterionIdSchema),
  rationale: nonBlankSchema,
  alternatives: z.array(z.strictObject({ title: nonBlankSchema, description: nonBlankSchema, rejection_reason: nonBlankSchema.optional() })).optional(),
  risks: z.array(z.strictObject({ description: nonBlankSchema, mitigation: nonBlankSchema.optional() })).optional(),
}).refine((d) => unique(d.requirements) && unique(d.acceptance_criteria), "duplicate-design-reference");
const section = z.strictObject({ summary: nonBlankSchema, markdown: nonBlankSchema.optional() });
export const designSchema = z.strictObject({
  schema: z.literal("aira.dev/design/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  summary: nonBlankSchema, decisions: z.array(designDecisionSchema),
  sections: z.strictObject({
    architecture_context: section.optional(),
    components: z.array(z.strictObject({ name: nonBlankSchema, responsibility: nonBlankSchema, interfaces: z.array(nonBlankSchema) })).optional(),
    interfaces: section.optional(), data_flow: section.optional(), failure_behavior: section.optional(),
    concurrency: section.optional(), security: section.optional(), compatibility: section.optional(), migration: section.optional(),
    observability: section.optional(), performance: section.optional(), deployment_impact: section.optional(),
    testing_strategy: section.optional(), rollback: section.optional(), out_of_scope: section.optional(),
  }),
}).refine((d) => unique(d.decisions.map((decision) => decision.id)), "duplicate-design-decision");
export type Design = DeepReadonly<z.infer<typeof designSchema>>;
export type DesignDecision = DeepReadonly<z.infer<typeof designDecisionSchema>>;
export function validateDesign(design: Design, requirements: Requirements): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const acs = new Set(requirements.requirements.flatMap((r) => r.acceptance_criteria.map((a) => a.id)));
  for (const decision of design.decisions) {
    for (const id of decision.requirements) if (!requirements.requirements.some((r) => r.id === id))
      issues.push({ code: "unknown-design-requirement", subject: decision.id, requirement: id });
    for (const id of decision.acceptance_criteria) {
      if (!acs.has(id)) issues.push({ code: "unknown-design-acceptance-criterion", subject: decision.id, related: [id] });
      if (!decision.requirements.some((r) => id.startsWith(`${r}.`)))
        issues.push({ code: "design-acceptance-parent-missing", subject: decision.id, related: [id] });
    }
  }
  return stableIssues(issues);
}
