import { canonical, compareText, cyclicComponents, exact } from "../spec/domain/primitives";
import { steeringRevisionKey, steeringRevisionReferenceSchema, type SteeringRevisionReference } from "./ids";
import { distinct, sorted, type SteeringResolutionIssue } from "./resolution-contract";
import { steeringResourceRevisionSchema } from "./schema";
import { compareSteeringScopes, orderSteeringExpression, steeringExpressionImplies, steeringScopeEmpty } from "./scope";
import type { SteeringResourceRevision } from "./types";

export const steeringLayerRank = { template: 0, "project-root": 1, "project-scoped": 2, interoperability: 3, imported: 4 } as const;
export const compareSteeringResources = (a: SteeringResourceRevision, b: SteeringResourceRevision): number =>
  steeringLayerRank[a.layer] - steeringLayerRank[b.layer] || compareText(a.identity.id, b.identity.id) ||
  compareText(a.identity.revision, b.identity.revision) || compareText(a.identity.hash, b.identity.hash);

/** A comparison view for already-parsed domain sets; the persisted 05C-1 decoder remains strict. */
export function orderSteeringRevision(resource: SteeringResourceRevision): SteeringResourceRevision {
  return { ...resource,
    scope: orderSteeringExpression(resource.scope),
    inclusion: { ...resource.inclusion, selector: orderSteeringExpression(resource.inclusion.selector) },
    rules: [...resource.rules].map((rule) => ({ ...rule, enforcement: sorted(rule.enforcement),
      ...(rule.scope ? { scope: orderSteeringExpression(rule.scope) } : {}),
      ...(rule.inclusion ? { inclusion: { ...rule.inclusion, selector: orderSteeringExpression(rule.inclusion.selector) } } : {}),
    })).sort((a, b) => compareText(a.id, b.id)),
    default_enforcement: sorted(resource.default_enforcement),
    composition: { parents: sorted(resource.composition.parents), overrides: sorted(resource.composition.overrides) },
    compatibility: { ...resource.compatibility, required_schemas: sorted(resource.compatibility.required_schemas) },
    metadata: { ...resource.metadata, labels: sorted(resource.metadata.labels) },
    behavioral_assets: sorted(resource.behavioral_assets),
  };
}
const presentationIssue = (message: string): boolean => /^noncanonical-steering-.*(?:order|set|composite|schemas|labels|attribution)$/.test(message);

export function prepareSteeringCatalog(values: readonly unknown[]): { catalog: SteeringResourceRevision[]; issues: SteeringResolutionIssue[] } {
  const catalog: SteeringResourceRevision[] = [], issues: SteeringResolutionIssue[] = [];
  for (const value of values) {
    const initial = steeringResourceRevisionSchema.safeParse(value);
    // Only set-order and relational errors may proceed to the semantic graph validator.
    const relational = new Set(["steering-resource-cannot-inherit-own-lineage", "steering-resource-cannot-override-self", "duplicate-steering-parent", "duplicate-steering-override-target"]);
    if (!initial.success && initial.error.issues.some((issue) => !presentationIssue(issue.message) && !relational.has(issue.message))) {
      const identity = steeringRevisionReferenceSchema.safeParse((value as { identity?: unknown } | null)?.identity);
      for (const error of initial.error.issues) issues.push({
        code: error.path.includes("scope") ? "steering-scope-invalid" : "steering-input-invalid", severity: "error",
        ...(identity.success ? { resource: identity.data } : {}), detail: error.path.filter((part) => typeof part !== "number").join(".") || "resource-shape",
      });
      continue;
    }
    const resource = orderSteeringRevision(value as SteeringResourceRevision);
    const checked = steeringResourceRevisionSchema.safeParse(resource);
    if (!checked.success) {
      const duplicates = resource.rules.filter((rule, i) => resource.rules.findIndex((other) => other.id === rule.id) !== i);
      for (const rule of duplicates) issues.push({ code: "steering-duplicate-rule", severity: "error", resource: resource.identity, rule: rule.id });
      const remaining = checked.error.issues.filter((issue) => !relational.has(issue.message) &&
        !(issue.message === "noncanonical-steering-parent-order" && new Set(resource.composition.parents.map(canonical)).size < resource.composition.parents.length) &&
        !(issue.message === "noncanonical-steering-override-order" && new Set(resource.composition.overrides.map(canonical)).size < resource.composition.overrides.length) &&
        !(issue.message === "noncanonical-steering-rule-order" && duplicates.length));
      if (remaining.length) {
        issues.push({ code: "steering-input-invalid", severity: "error", resource: resource.identity, detail: "resource-declaration" });
        continue;
      }
    }
    catalog.push(resource);
  }
  return { catalog: catalog.sort(compareSteeringResources), issues };
}

export function validateSteeringHierarchy(catalog: readonly SteeringResourceRevision[], project: string): {
  order: SteeringResourceRevision[]; issues: SteeringResolutionIssue[];
} {
  const issues: SteeringResolutionIssue[] = [], edges = new Map<string, string[]>();
  for (const resource of catalog) {
    const ref = resource.identity, key = steeringRevisionKey(ref);
    const issue = (code: SteeringResolutionIssue["code"], detail?: string, related?: readonly SteeringRevisionReference[]): void => {
      issues.push({ code, severity: "error", resource: ref, ...(detail ? { detail } : {}), ...(related ? { related } : {}) });
    };
    if (catalog.filter((other) => steeringRevisionKey(other.identity) === key).length !== 1) issue("steering-duplicate-resource");
    if (resource.provenance.kind === "project" && resource.provenance.project !== project) issue("steering-project-mismatch");
    if (steeringScopeEmpty(resource.scope)) issue("steering-scope-invalid", "empty-scope");
    const native = resource.provenance.kind === "project";
    if (resource.provenance.kind === "project" && resource.provenance.adopted_from?.kind === "steering-revision" &&
      /^(?:project\.)?steering\./.test(resource.provenance.adopted_from.revision.id))
      issue("steering-source-invalid", "adoption-source-must-be-external", [resource.provenance.adopted_from.revision]);
    if (resource.default_authority === "enforceable" && resource.default_enforcement.some((binding) =>
      !resource.rules.some((rule) => rule.status === "active" && rule.authority === "enforceable" && rule.enforcement.some((other) => exact(binding, other)))))
      issue("steering-enforcement-weakening", "unstructured-default-enforcement");
    if (!native && (resource.composition.parents.length || resource.composition.overrides.length)) issue("steering-source-invalid", "external-composition-not-authorized");
    if (!native && resource.layer !== "template" && (resource.default_authority === "enforceable" || resource.rules.some((rule) => rule.authority === "enforceable")))
      issue("steering-source-invalid", "enforcement-requires-project-adoption");
    if (resource.layer === "project-scoped" && resource.composition.parents.length === 0) issue("steering-parent-missing", "scoped-parent-required");
    const parentKeys = resource.composition.parents.map(steeringRevisionKey);
    if (new Set(parentKeys).size !== parentKeys.length) issue("steering-parent-duplicate", undefined, resource.composition.parents);
    edges.set(key, distinct([...(edges.get(key) ?? []), ...parentKeys]));
    for (const refParent of resource.composition.parents) {
      const parent = catalog.find((candidate) => exact(candidate.identity, refParent));
      if (refParent.id === ref.id) issue("steering-parent-invalid", "own-lineage", [refParent]);
      if (!parent) { issue("steering-parent-missing", "exact-revision-unavailable", [refParent]); continue; }
      if (resource.layer !== "project-scoped" || parent.provenance.kind !== "project" || !native)
        issue("steering-parent-invalid", "source-relationship", [refParent]);
      if (compareSteeringScopes(resource.scope, parent.scope) !== "narrower") issue("steering-scope-widening", "parent-narrowing-unproven", [refParent]);
    }
    for (const rule of resource.rules) {
      if (rule.scope && !["equal", "narrower"].includes(compareSteeringScopes(rule.scope, resource.scope)))
        issues.push({ code: steeringScopeEmpty(rule.scope) ? "steering-scope-invalid" : "steering-scope-widening", severity: "error", resource: ref, rule: rule.id, detail: "rule-scope" });
      if (rule.inclusion && !steeringExpressionImplies(rule.inclusion.selector, resource.inclusion.selector))
        issues.push({ code: "steering-inclusion-widening", severity: "error", resource: ref, rule: rule.id });
    }
    for (const declaration of resource.composition.overrides) {
      const targets = resource.composition.overrides.filter((other) => exact(other.target, declaration.target));
      if (targets.length !== 1) issue("steering-override-ambiguous", "duplicate-target", [declaration.target.resource]);
      if (resource.composition.overrides.some((other) => !exact(other.target, declaration.target) &&
        exact(other.target.resource, declaration.target.resource) && (other.target.rule === undefined || declaration.target.rule === undefined)))
        issue("steering-override-ambiguous", "overlapping-target-declarations", [declaration.target.resource]);
      const target = catalog.find((candidate) => exact(candidate.identity, declaration.target.resource));
      if (!target || (declaration.target.rule && !target.rules.some((rule) => rule.id === declaration.target.rule)))
        issue("steering-override-target-missing", undefined, [declaration.target.resource]);
      if (!resource.composition.parents.some((parent) => exact(parent, declaration.target.resource)) || declaration.target.resource.id === ref.id)
        issue("steering-override-not-allowed", "exact-direct-parent-required", [declaration.target.resource]);
    }
  }
  for (const cycle of cyclicComponents(edges)) issues.push({ code: "steering-parent-cycle", severity: "error",
    related: catalog.filter((resource) => cycle.includes(steeringRevisionKey(resource.identity))).map((resource) => resource.identity) });
  // Kahn order: parent dependencies first; semantic source rank and exact logical identities break ready-set ties only.
  const order: SteeringResourceRevision[] = [], emitted = new Set<string>();
  while (order.length < catalog.length) {
    const next = catalog.filter((resource) => !emitted.has(steeringRevisionKey(resource.identity)) &&
      resource.composition.parents.every((parent) => emitted.has(steeringRevisionKey(parent)))) .sort(compareSteeringResources)[0];
    if (!next) break;
    order.push(next); emitted.add(steeringRevisionKey(next.identity));
  }
  return { order, issues };
}
