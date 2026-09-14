import type { ProductDefinition } from "./product";
import type { Requirements } from "./requirements";
import type { SystemArchitecture } from "./architecture";
import type { ProgramDesign } from "./program-design";
import type { SlicePlan } from "./slices";
import type { Tasks } from "../../tasks/types";
import type { VerificationPlan } from "../../verification/types";
import type { Analysis } from "./analysis";
import { stableIssues, type DomainIssue } from "./primitives";

export type PlanningDocument = ProductDefinition | Requirements | SystemArchitecture | ProgramDesign | SlicePlan | Tasks | VerificationPlan;
/** Exact semantic hash subjects for optional fine-grained lineage. Array order is not identity. */
export function planningEntities(document: PlanningDocument): readonly { readonly id: string; readonly value: unknown }[] {
  switch (document.schema) {
    case "aira.dev/product/v1": {
      const { schema, spec_id, revision, outcomes, success_criteria, ...context } = document;
      return [...outcomes, ...success_criteria].map((entity) => ({ id: entity.id, value: { entity, context } }));
    }
    case "aira.dev/requirements/v2": return document.requirements.flatMap((r) => [{ id: r.id, value: r }, ...r.acceptance_criteria.map((a) => ({ id: a.id, value: a }))]);
    case "aira.dev/architecture/v1": return document.decisions.map((entity) => ({ id: entity.id, value: { entity, summary: document.summary, sections: document.sections } }));
    case "aira.dev/program-design/v1": {
      const { schema, spec_id, revision, decisions, files, symbols, ...context } = document;
      return decisions.map((entity) => ({ id: entity.id, value: { entity, context,
        files: files.filter((f) => entity.files.includes(f.path)), symbols: symbols.filter((s) => entity.symbols.includes(s.id)) } }));
    }
    case "aira.dev/slice-plan/v1": return document.slices.map((s) => ({ id: s.id, value: s }));
    case "aira.dev/tasks/v2": return document.tasks.map((t) => ({ id: t.identity.id, value: t }));
    case "aira.dev/verification-plan/v2": return document.verifiers.map((v) => ({ id: v.identity.id, value: v }));
  }
}
export function validateFindingTargets(analyses: readonly Analysis[], documents: readonly PlanningDocument[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  for (const analysis of analyses) for (const finding of analysis.findings) for (const target of finding.targets) {
    const entities = "references" in target ? target.references : "id" in target ? [target] : [];
    for (const entity of entities) {
      const document = documents.find((d) => d.spec_id === analysis.spec_id && d.revision === entity.artifact.revision);
      if (!document || !planningEntities(document).some((e) => e.id === entity.id))
        issues.push({ code: "unknown-finding-entity", subject: finding.id, related: [entity.id, entity.artifact.revision] });
    }
  }
  return stableIssues(issues);
}
