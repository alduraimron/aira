import { z } from "zod";
import { acceptanceCriterionIdSchema, artifactRevisionIdSchema, architectureDecisionIdSchema, requirementIdSchema, specIdSchema } from "./ids";
import { nonBlankSchema, unique, stableIssues, type DomainIssue, type DeepReadonly } from "./primitives";
import type { Requirements } from "./requirements";
import { productRiskSchema } from "./product";

export const alternativeSchema = z.strictObject({ title: nonBlankSchema, description: nonBlankSchema, rejection_reason: nonBlankSchema.optional() });
export const architectureDecisionSchema = z.strictObject({
  id: architectureDecisionIdSchema, title: nonBlankSchema, description: nonBlankSchema,
  requirements: z.array(requirementIdSchema), acceptance_criteria: z.array(acceptanceCriterionIdSchema),
  rationale: nonBlankSchema, alternatives: z.array(alternativeSchema).optional(), risks: z.array(productRiskSchema).optional(),
}).refine((d) => unique(d.requirements) && unique(d.acceptance_criteria), "duplicate-architecture-reference");
const section = z.strictObject({ summary: nonBlankSchema, markdown: nonBlankSchema.optional() });
export const architectureSchema = z.strictObject({
  schema: z.literal("aira.dev/architecture/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  summary: nonBlankSchema, decisions: z.array(architectureDecisionSchema),
  sections: z.strictObject({
    system_context: section.optional(),
    components: z.array(z.strictObject({ name: nonBlankSchema, responsibility: nonBlankSchema, owner: nonBlankSchema,
      boundary: nonBlankSchema, interfaces: z.array(nonBlankSchema) })).optional(),
    dependencies: z.array(z.strictObject({ from: nonBlankSchema, to: nonBlankSchema, rationale: nonBlankSchema })).optional(),
    interfaces: z.array(z.strictObject({ name: nonBlankSchema, owner: nonBlankSchema,
      kind: z.enum(["api", "event", "message", "interface"]), contract: nonBlankSchema })).optional(),
    data_ownership: z.array(z.strictObject({ data: nonBlankSchema, owner: nonBlankSchema, persistence: nonBlankSchema })).optional(),
    storage: section.optional(), data_flow: section.optional(), interactions: section.optional(),
    external_systems: z.array(z.strictObject({ name: nonBlankSchema, contract: nonBlankSchema, trust: nonBlankSchema })).optional(),
    failure_boundaries: section.optional(), concurrency: section.optional(), security: section.optional(),
    compatibility: section.optional(), migration: section.optional(), observability: section.optional(),
    performance: section.optional(), deployment: section.optional(), rollback: section.optional(),
    alternatives: z.array(alternativeSchema).optional(), risks: z.array(productRiskSchema).optional(), non_goals: z.array(nonBlankSchema).optional(),
  }),
}).refine((a) => unique(a.decisions.map((d) => d.id)) && unique((a.sections.components ?? []).map((c) => c.name)) &&
  unique((a.sections.interfaces ?? []).map((i) => i.name)), "duplicate-architecture-identity");
export type SystemArchitecture = DeepReadonly<z.infer<typeof architectureSchema>>;
export type ArchitectureDecision = DeepReadonly<z.infer<typeof architectureDecisionSchema>>;
export function requirementReferenceIssues(subject: string, refs: readonly string[], criteria: readonly string[], requirements: Requirements, prefix: string): DomainIssue[] {
  const issues: DomainIssue[] = [];
  for (const id of refs) if (!requirements.requirements.some((r) => r.id === id))
    issues.push({ code: `unknown-${prefix}-requirement`, subject, requirement: id });
  for (const id of criteria) {
    if (!requirements.requirements.some((r) => r.acceptance_criteria.some((a) => a.id === id)))
      issues.push({ code: `unknown-${prefix}-acceptance-criterion`, subject, related: [id] });
    if (!refs.some((r) => id.startsWith(`${r}.`))) issues.push({ code: `${prefix}-acceptance-parent-missing`, subject, related: [id] });
  }
  return issues;
}
/** Proposals may precede Requirements. Supplied catalogs always receive strict reference checks. */
export function validateArchitecture(value: unknown, requirements?: Requirements): DomainIssue[] {
  const parsed = architectureSchema.safeParse(value);
  if (!parsed.success) return [{ code: "invalid-architecture" }];
  const architecture = parsed.data, issues: DomainIssue[] = [];
  if (requirements) {
    if (architecture.spec_id !== requirements.spec_id) issues.push({ code: "cross-spec-architecture" });
    for (const d of architecture.decisions) issues.push(...requirementReferenceIssues(d.id, d.requirements, d.acceptance_criteria, requirements, "architecture"));
  } else if (architecture.decisions.some((d) => d.requirements.length || d.acceptance_criteria.length)) issues.push({ code: "architecture-requirements-unavailable" });
  const names = (architecture.sections.components ?? []).map((c) => c.name);
  for (const d of architecture.sections.dependencies ?? []) for (const name of [d.from, d.to])
    if (!names.includes(name)) issues.push({ code: "unknown-architecture-component", subject: name });
  return stableIssues(issues);
}
