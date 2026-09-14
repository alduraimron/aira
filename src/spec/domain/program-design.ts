import { z } from "zod";
import { acceptanceCriterionIdSchema, architectureDecisionIdSchema, artifactRevisionIdSchema, programDesignDecisionIdSchema, requirementIdSchema, specIdSchema } from "./ids";
import { nonBlankSchema, unique, stableIssues, type DeepReadonly, type DomainIssue } from "./primitives";
import { exactPathSchema } from "../../context/declarations";
import { alternativeSchema, requirementReferenceIssues, type SystemArchitecture } from "./architecture";
import { productRiskSchema } from "./product";
import type { Requirements } from "./requirements";

export const programDesignDecisionSchema = z.strictObject({
  id: programDesignDecisionIdSchema, title: nonBlankSchema, description: nonBlankSchema,
  architecture_decisions: z.array(architectureDecisionIdSchema), requirements: z.array(requirementIdSchema),
  acceptance_criteria: z.array(acceptanceCriterionIdSchema), files: z.array(exactPathSchema), symbols: z.array(nonBlankSchema),
  rationale: nonBlankSchema, alternatives: z.array(alternativeSchema), risks: z.array(productRiskSchema),
  uncertainty: z.strictObject({ status: z.enum(["decided", "uncertain", "human-clarification-required"]),
    confidence: z.enum(["low", "medium", "high"]), risk: nonBlankSchema, open_alternatives: z.array(nonBlankSchema), questions: z.array(nonBlankSchema) }),
}).refine((d) => [d.architecture_decisions, d.requirements, d.acceptance_criteria, d.files, d.symbols].every(unique) &&
  (d.uncertainty.status !== "human-clarification-required" || d.uncertainty.questions.length > 0), "invalid-program-design-decision");
export const programDesignSchema = z.strictObject({
  schema: z.literal("aira.dev/program-design/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  summary: nonBlankSchema, decisions: z.array(programDesignDecisionSchema),
  files: z.array(z.strictObject({ path: exactPathSchema, action: z.enum(["create", "modify", "remove"]), responsibility: nonBlankSchema, owner: nonBlankSchema })),
  symbols: z.array(z.strictObject({ id: nonBlankSchema, file: exactPathSchema, name: nonBlankSchema,
    kind: z.enum(["type", "interface", "class", "function", "method", "constant"]), responsibility: nonBlankSchema,
    signature: nonBlankSchema, inputs: z.array(nonBlankSchema), outputs: z.array(nonBlankSchema), errors: z.array(nonBlankSchema) })),
  call_paths: z.array(z.strictObject({ entry: nonBlankSchema, symbols: z.array(nonBlankSchema).min(1), result: nonBlankSchema })),
  transformations: z.array(z.strictObject({ input: nonBlankSchema, transitions: z.array(nonBlankSchema).min(1),
    persistence_operations: z.array(nonBlankSchema), output: nonBlankSchema, preserved_invariants: z.array(nonBlankSchema) })),
  error_flows: z.array(z.strictObject({ origin: nonBlankSchema, translation: nonBlankSchema, propagation: z.array(nonBlankSchema), visible_result: nonBlankSchema })),
  concurrency: z.array(nonBlankSchema).optional(),
  tests: z.array(z.strictObject({ kind: z.enum(["unit", "integration", "contract", "regression", "failure", "concurrency"]),
    boundary: nonBlankSchema, scenario: nonBlankSchema, expected: nonBlankSchema, symbols: z.array(nonBlankSchema) })),
  constraints: z.strictObject({ follow: z.array(nonBlankSchema), avoid: z.array(nonBlankSchema), dependencies: z.array(nonBlankSchema), compatibility: z.array(nonBlankSchema) }),
}).refine((p) => unique(p.decisions.map((d) => d.id)) && unique(p.files.map((f) => f.path)) && unique(p.symbols.map((s) => s.id)), "duplicate-program-design-identity");
export type ProgramDesign = DeepReadonly<z.infer<typeof programDesignSchema>>;
export type ProgramDesignDecision = DeepReadonly<z.infer<typeof programDesignDecisionSchema>>;
export function validateProgramDesign(value: unknown, architecture: SystemArchitecture, requirements: Requirements): DomainIssue[] {
  const parsed = programDesignSchema.safeParse(value);
  if (!parsed.success) return [{ code: "invalid-program-design" }];
  const p = parsed.data, issues: DomainIssue[] = [];
  if (p.spec_id !== architecture.spec_id || p.spec_id !== requirements.spec_id) issues.push({ code: "cross-spec-program-design" });
  const file = (path: string, subject: string): void => {
    if (!p.files.some((f) => f.path === path && f.action !== "remove")) issues.push({ code: "unknown-program-design-file", subject, related: [path] });
  };
  const symbol = (id: string, subject: string): void => {
    if (!p.symbols.some((s) => s.id === id)) issues.push({ code: "unknown-program-design-symbol", subject, related: [id] });
  };
  for (const s of p.symbols) file(s.file, s.id);
  for (const d of p.decisions) {
    issues.push(...requirementReferenceIssues(d.id, d.requirements, d.acceptance_criteria, requirements, "program-design"));
    for (const a of d.architecture_decisions) if (!architecture.decisions.some((decision) => decision.id === a))
      issues.push({ code: "unknown-program-design-architecture", subject: d.id, related: [a] });
    for (const path of d.files) if (!p.files.some((f) => f.path === path)) issues.push({ code: "unknown-program-design-file", subject: d.id, related: [path] });
    for (const id of d.symbols) symbol(id, d.id);
  }
  for (const path of p.call_paths) for (const id of path.symbols) symbol(id, path.entry);
  for (const test of p.tests) for (const id of test.symbols) symbol(id, test.scenario);
  return stableIssues(issues);
}
