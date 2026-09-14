import { z } from "zod";
import { acceptanceCriterionIdSchema, artifactRevisionIdSchema, contextDeclarationIdSchema, architectureDecisionIdSchema, programDesignDecisionIdSchema, sliceIdSchema, requirementIdSchema, specIdSchema, taskIdSchema, verifierIdSchema } from "../spec/domain/ids";
import { artifactReferenceSchema } from "../spec/domain/artifacts";
import { contentHashSchema, nonBlankSchema, policyReferenceSchema, profileReferenceSchema, safeUnsignedSchema, unique, canonical, cyclicComponents, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import { contextDeclarationSchema } from "../context/declarations";
import { taskDefinitionReferenceSchema } from "../execution/schema";
import { workspaceRequirementsSchema } from "../workspace/schema";
import { taskBehavioralSelectionsSchema } from "../builtins/roles";

export const completionConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("verification"), verifier: verifierIdSchema }),
  z.strictObject({ kind: z.literal("artifact-published"), artifact: artifactReferenceSchema }),
]);
export const taskDefinitionSchema = z.strictObject({
  schema: z.literal("aira.dev/task-definition/v2"), identity: taskDefinitionReferenceSchema,
  title: nonBlankSchema, kind: z.enum(["implementation", "test", "migration", "configuration", "documentation", "cleanup", "investigation", "custom"]),
  custom_kind: nonBlankSchema.optional(), description: nonBlankSchema, outcome: nonBlankSchema,
  requirements: z.array(requirementIdSchema), acceptance_criteria: z.array(acceptanceCriterionIdSchema),
  architecture_decisions: z.array(architectureDecisionIdSchema), program_design_decisions: z.array(programDesignDecisionIdSchema),
  slice: sliceIdSchema, dependencies: z.array(taskIdSchema),
  required: z.boolean(), completion: z.array(completionConditionSchema).min(1), verifiers: z.array(verifierIdSchema),
  context: z.strictObject({ declarations: z.array(contextDeclarationSchema),
    references: z.array(z.strictObject({ id: contextDeclarationIdSchema, revision: artifactRevisionIdSchema, hash: contentHashSchema })) }),
  capability_policy: policyReferenceSchema, execution_profile: profileReferenceSchema,
  behavioral_selections: taskBehavioralSelectionsSchema,
  workspace: workspaceRequirementsSchema,
  scheduling: z.strictObject({ priority: safeUnsignedSchema, estimated_cost: safeUnsignedSchema.optional(),
    exclusive_resources: z.array(nonBlankSchema), labels: z.array(nonBlankSchema) }),
}).refine((t) => (t.kind === "custom") === (t.custom_kind !== undefined) &&
  [t.requirements, t.acceptance_criteria, t.architecture_decisions, t.program_design_decisions, t.dependencies, t.verifiers].every(unique) &&
  unique([...t.context.declarations, ...t.context.references].map((d) => d.id)) &&
  unique(t.completion.map(canonical)) && unique(t.scheduling.exclusive_resources) && unique(t.scheduling.labels) &&
  t.completion.every((c) => c.kind !== "verification" || t.verifiers.includes(c.verifier)), "invalid-task-definition");
// The shape-only decoder is used to produce semantic-ID graph diagnostics.
export const tasksDocumentSchema = z.strictObject({
  schema: z.literal("aira.dev/tasks/v2"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  ordering: z.literal("priority-then-task-id-codepoint"), tasks: z.array(taskDefinitionSchema).min(1),
});
export function taskGraphShapeIssues(tasks: readonly z.infer<typeof taskDefinitionSchema>[]): DomainIssue[] {
  const ids = tasks.map((t) => t.identity.id), edges = new Map<string, string[]>(), issues: DomainIssue[] = [];
  for (const task of tasks) {
    const id = task.identity.id;
    if (ids.filter((other) => other === id).length !== 1) issues.push({ code: "duplicate-task", task: id });
    edges.set(id, [...new Set([...(edges.get(id) ?? []), ...task.dependencies])]);
    for (const dependency of task.dependencies) {
      if (dependency === id) issues.push({ code: "self-dependency", task: id });
      if (!ids.includes(dependency)) issues.push({ code: "unknown-dependency", task: id, subject: dependency });
    }
  }
  for (const cycle of cyclicComponents(edges)) issues.push({ code: "task-cycle", related: cycle });
  return stableIssues(issues);
}
export const tasksSchema = tasksDocumentSchema.superRefine((document, ctx) => {
  for (const issue of taskGraphShapeIssues(document.tasks)) ctx.addIssue({ code: "custom", message: canonical(issue) });
});
