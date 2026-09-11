import type { Requirement } from "../spec/domain/requirements";
import type { DesignDecision } from "../spec/domain/design";
import { compareText, exact, stableIssues, type DomainIssue, type PolicyReference, type ProfileReference } from "../spec/domain/primitives";
import type { ContextDeclaration } from "../context/declarations";
import { tasksDocumentSchema, taskGraphShapeIssues } from "./schema";
import type { TaskDefinition } from "./types";

export interface TaskReferenceCatalog {
  readonly requirements: readonly Requirement[];
  readonly decisions: readonly DesignDecision[];
  readonly verifiers: readonly { id: string }[];
  readonly policies: readonly PolicyReference[];
  readonly execution_profiles: readonly ProfileReference[];
  readonly contexts: readonly { id: ContextDeclaration["id"]; revision: string; hash: string }[];
}
/** Accepts unknown at the boundary; reports paths as semantic IDs, not array positions. */
export function validateTaskGraph(value: unknown, catalog: TaskReferenceCatalog): DomainIssue[] {
  const parsed = tasksDocumentSchema.safeParse(value);
  if (!parsed.success) return [{ code: "invalid-task-graph-shape" }];
  const graph = parsed.data, issues: DomainIssue[] = taskGraphShapeIssues(graph.tasks);
  const acs = new Set(catalog.requirements.flatMap((r) => r.acceptance_criteria.map((a) => a.id)));
  for (const task of graph.tasks) {
    const id = task.identity.id;
    for (const requirement of task.requirements) if (!catalog.requirements.some((r) => r.id === requirement))
      issues.push({ code: "unknown-task-requirement", task: id, requirement });
    for (const ac of task.acceptance_criteria) {
      if (!acs.has(ac)) issues.push({ code: "unknown-task-acceptance-criterion", task: id, subject: ac });
      if (!task.requirements.some((r) => ac.startsWith(`${r}.`))) issues.push({ code: "task-acceptance-parent-missing", task: id, subject: ac });
    }
    for (const decision of task.design_decisions) if (!catalog.decisions.some((d) => d.id === decision))
      issues.push({ code: "unknown-task-design-decision", task: id, subject: decision });
    for (const verifier of task.verifiers) if (!catalog.verifiers.some((v) => v.id === verifier))
      issues.push({ code: "unknown-task-verifier", task: id, verifier });
    if (!catalog.policies.some((p) => exact(p, task.capability_policy))) issues.push({ code: "unknown-task-policy", task: id });
    if (!catalog.execution_profiles.some((p) => exact(p, task.execution_profile))) issues.push({ code: "unknown-task-execution-profile", task: id });
    for (const ref of task.context.references) if (!catalog.contexts.some((c) => exact(c, ref)))
      issues.push({ code: "unknown-task-context", task: id, subject: ref.id });
  }
  return stableIssues(issues);
}
export function orderTasks(tasks: readonly TaskDefinition[]): TaskDefinition[] {
  return [...tasks].sort((a, b) => b.scheduling.priority - a.scheduling.priority || compareText(a.identity.id, b.identity.id));
}
