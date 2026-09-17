import { canonical, exact } from "../spec/domain/primitives";
import { composeSteeringRules } from "./conflicts";
import { prepareSteeringCatalog, validateSteeringHierarchy } from "./hierarchy";
import type { SteeringRevisionReference, SteeringRuleId } from "./ids";
import {
  STEERING_RESOLVER_LIMITS, STEERING_RESOLVER_POLICY, STEERING_RESOLVER_SCHEMA,
  distinct, freezeResolution, sorted, stableResolutionIssues, steeringResolutionInputsSchema,
  type SteeringApplicableRule, type SteeringEvaluation, type SteeringIncludedResource, type SteeringOmission,
  type SteeringResolutionInputs, type SteeringResolutionIssue, type SteeringResolutionResult,
} from "./resolution-contract";
import { containsManualSelector, evaluateSteeringExpression, intersectSteeringScopes, orderSteeringExpression, steeringEvaluationScope, steeringScopeEmpty, unionSteeringScopes } from "./scope";

/** Guard recursive schemas and quadratic graph/conflict work before trusting a typed caller. */
function boundedInput(value: unknown): boolean {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > STEERING_RESOLVER_LIMITS.nodes || depth > STEERING_RESOLVER_LIMITS.depth) return false;
    if (typeof item === "string") return item.length <= 16_384;
    if (typeof item === "number") return Number.isFinite(item);
    if (item === null || item === undefined || typeof item === "boolean") return true;
    if (typeof item !== "object" || ancestors.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) return false;
    ancestors.add(item);
    const valid = Object.entries(item).every(([key, child]) =>
      (!(key === "path" || key === "pattern") || typeof child !== "string" ||
        (child.length <= STEERING_RESOLVER_LIMITS.path_length && child.split("/").length <= STEERING_RESOLVER_LIMITS.path_segments)) && visit(child, depth + 1));
    ancestors.delete(item); return valid;
  };
  return visit(value, 0);
}
const resultBase = { schema: STEERING_RESOLVER_SCHEMA, policy: STEERING_RESOLVER_POLICY };
function finish(value: SteeringResolutionResult): SteeringResolutionResult {
  // Detached canonical comparison representation. This is not a snapshot encoding or hash subject.
  return freezeResolution(JSON.parse(canonical({ ...value, diagnostics: stableResolutionIssues(value.diagnostics) })) as SteeringResolutionResult);
}
const invalid = (diagnostics: readonly SteeringResolutionIssue[]): SteeringResolutionResult => finish({ ...resultBase, status: "invalid-input", diagnostics });

/** Pure exact-input resolution. No discovery, publication, authentication, hashing, or runtime enforcement. */
export function resolveSteering(request: unknown): SteeringResolutionResult {
  if (!boundedInput(request)) return invalid([{ code: "steering-input-limit", severity: "error" }]);
  if (!request || typeof request !== "object" || Array.isArray(request)) return invalid([{ code: "steering-input-invalid", severity: "error" }]);
  const { catalog: rawCatalog, ...rawInputs } = request as Record<string, unknown>;
  if (rawInputs.schema !== STEERING_RESOLVER_SCHEMA || rawInputs.policy !== STEERING_RESOLVER_POLICY)
    return invalid([{ code: "steering-policy-unsupported", severity: "error" }]);
  if (!Array.isArray(rawCatalog) || rawCatalog.length > STEERING_RESOLVER_LIMITS.resources)
    return invalid([{ code: "steering-input-invalid", severity: "error", detail: "catalog" }]);
  const initial = steeringResolutionInputsSchema.safeParse(rawInputs);
  // Already-parsed input sets can arrive in different presentation order. Invalid shapes are not repaired.
  if (!initial.success && initial.error.issues.some((issue) => !/^noncanonical-steering-.*(?:set|order|composite)$/.test(issue.message))) {
    const diagnostics: SteeringResolutionIssue[] = initial.error.issues.map((issue) => ({
      code: issue.path.includes("authorization") ? "steering-manual-unauthorized" :
        issue.path.join(".") === "action.phase" && (rawInputs.action as { phase?: unknown } | undefined)?.phase === undefined ? "steering-inclusion-input-missing" : "steering-input-invalid",
      severity: "error", detail: issue.path.filter((part) => typeof part !== "number").join(".") || "request-shape",
    }));
    return invalid(diagnostics);
  }
  const inputView = rawInputs as unknown as SteeringResolutionInputs;
  const parsed = steeringResolutionInputsSchema.safeParse({ ...inputView,
    selections: sorted(inputView.selections.map((selection) => ({ ...selection, inclusion: { ...selection.inclusion, selector: orderSteeringExpression(selection.inclusion.selector) } }))),
    manual: sorted(inputView.manual), supported_contracts: sorted(inputView.supported_contracts), available_enforcement: sorted(inputView.available_enforcement),
    action: { ...inputView.action, ...(inputView.action.paths?.status === "known" ? { paths: { status: "known", paths: sorted(inputView.action.paths.paths) } } : {}) },
  });
  if (!parsed.success) return invalid([{ code: "steering-input-invalid", severity: "error", detail: "noncanonical-or-duplicate-selector" }]);
  const inputs: SteeringResolutionInputs = parsed.data;
  const prepared = prepareSteeringCatalog(rawCatalog), catalog = prepared.catalog;
  const diagnostics: SteeringResolutionIssue[] = [...prepared.issues];
  if (catalog.some((resource) => resource.rules.length > STEERING_RESOLVER_LIMITS.rules_per_resource) || catalog.reduce((count, resource) => count + resource.rules.length, 0) > STEERING_RESOLVER_LIMITS.total_rules)
    return invalid([{ code: "steering-input-limit", severity: "error", detail: "rule-count" }]);
  const hierarchy = validateSteeringHierarchy(catalog, inputs.project);
  diagnostics.push(...hierarchy.issues);
  for (const selection of inputs.selections) if (inputs.selections.filter((other) => exact(other.resource, selection.resource)).length !== 1)
    diagnostics.push({ code: "steering-duplicate-selection", severity: "error", resource: selection.resource });
  for (const selection of inputs.manual) {
    if (selection.authorization.project !== inputs.project) diagnostics.push({ code: "steering-manual-unauthorized", severity: "error", resource: selection.resource, detail: "project-mismatch" });
    if (inputs.manual.filter((other) => exact(other.resource, selection.resource) && other.rule === selection.rule).length !== 1)
      diagnostics.push({ code: "steering-duplicate-selection", severity: "error", resource: selection.resource, ...(selection.rule ? { rule: selection.rule } : {}) });
  }
  if (distinct(inputs.supported_contracts).length !== inputs.supported_contracts.length || distinct(inputs.available_enforcement).length !== inputs.available_enforcement.length ||
    (inputs.action.paths?.status === "known" && distinct(inputs.action.paths.paths).length !== inputs.action.paths.paths.length))
    diagnostics.push({ code: "steering-input-invalid", severity: "error", detail: "duplicate-input-set-member" });
  if (diagnostics.some((issue) => !issue.code.startsWith("steering-override-"))) return invalid(diagnostics);

  const omissions: SteeringOmission[] = [], included = new Map<string, SteeringIncludedResource>();
  const isManual = (resource: SteeringRevisionReference, rule?: SteeringRuleId): boolean => inputs.manual.some((selection) => exact(selection.resource, resource) && selection.rule === rule);
  const evaluationIssues = (evaluation: SteeringEvaluation, resource: SteeringRevisionReference, rule?: SteeringRuleId): void => {
    for (const missing of evaluation.missing) diagnostics.push({ code: "steering-inclusion-input-missing", severity: "error", resource,
      ...(rule ? { rule } : {}), detail: missing });
  };
  const include = (ref: SteeringRevisionReference, availability: "required" | "optional", reason: SteeringIncludedResource["reasons"][number]): boolean => {
    const resource = catalog.find((candidate) => exact(candidate.identity, ref));
    evaluationIssues(reason.evaluation, ref);
    if (!resource) {
      if (reason.evaluation.outcome === "match") {
        diagnostics.push({ code: reason.kind === "manual" ? "steering-manual-selection-missing" : availability === "required" ? "steering-required-resource-missing" : "steering-optional-resource-missing",
          severity: availability === "required" ? "error" : "warning", resource: ref });
        omissions.push({ resource: ref, availability, reason: "unavailable" });
      } else if (reason.evaluation.outcome === "miss") omissions.push({ resource: ref, availability, reason: "selector-miss" });
      return false;
    }
    const scope = evaluateSteeringExpression(resource.scope, inputs.action);
    const inclusion = evaluateSteeringExpression(resource.inclusion.selector, inputs.action, isManual(ref));
    evaluationIssues(scope, ref); evaluationIssues(inclusion, ref);
    const effectiveAvailability = availability === "required" || resource.inclusion.availability === "required" ? "required" : "optional";
    if ([reason.evaluation, scope, inclusion].some((evaluation) => evaluation.outcome === "error")) return false;
    if (reason.evaluation.outcome === "miss" || inclusion.outcome === "miss" || scope.outcome === "miss") {
      omissions.push({ resource: ref, availability: effectiveAvailability, reason: scope.outcome === "miss" ? "scope-miss" :
        inclusion.outcome === "miss" && containsManualSelector(resource.inclusion.selector) && !isManual(ref) ? "manual-unselected" : "selector-miss" });
      return false;
    }
    if (resource.layer === "template") { diagnostics.push({ code: "steering-source-invalid", severity: "error", resource: ref, detail: "template-adoption-required" }); return false; }
    const unsupported = resource.compatibility.required_schemas.filter((contract) => !inputs.supported_contracts.includes(contract));
    if (unsupported.length) {
      const failClosed = effectiveAvailability === "required" || resource.default_authority === "enforceable" || resource.rules.some((rule) => rule.status === "active" && rule.authority === "enforceable");
      diagnostics.push({ code: "steering-compatibility-invalid", severity: failClosed ? "error" : "warning", resource: ref, detail: canonical(unsupported) });
      omissions.push({ resource: ref, availability: effectiveAvailability, reason: "unavailable" }); return false;
    }
    const key = canonical(ref), previous = included.get(key);
    if (previous) { included.set(key, { ...previous, reasons: distinct([...previous.reasons, reason]) }); return true; }
    included.set(key, { revision: resource, tier: resource.layer, order: hierarchy.order.indexOf(resource), scope: resource.scope, reasons: [reason], scope_evaluation: scope, inclusion_evaluation: inclusion });
    for (const parent of resource.composition.parents) {
      const parentIncluded = include(parent, "required", { kind: "parent", from: ref, evaluation: evaluateSteeringExpression({ kind: "always" }, inputs.action) });
      if (!parentIncluded) diagnostics.push({ code: "steering-parent-missing", severity: "error", resource: ref, related: [parent], detail: "parent-not-applicable-or-compatible" });
    }
    return true;
  };
  for (const selection of inputs.selections) include(selection.resource, selection.inclusion.availability, {
    kind: "selection", evaluation: evaluateSteeringExpression(selection.inclusion.selector, inputs.action, isManual(selection.resource)),
  });
  for (const selection of inputs.manual) {
    const resource = catalog.find((candidate) => exact(candidate.identity, selection.resource));
    if (selection.rule && resource && !resource.rules.some((rule) => rule.id === selection.rule && rule.status === "active")) {
      diagnostics.push({ code: "steering-manual-selection-missing", severity: selection.availability === "required" ? "error" : "warning", resource: selection.resource, rule: selection.rule });
      omissions.push({ resource: selection.resource, rule: selection.rule, availability: selection.availability, reason: "unavailable" });
    }
    include(selection.resource, selection.availability, { kind: "manual", evaluation: evaluateSteeringExpression({ kind: "manual" }, inputs.action, true) });
  }
  const resources = [...included.values()].sort((a, b) => a.order - b.order).map((entry) => ({ ...entry, reasons: distinct(entry.reasons),
    scope: intersectSteeringScopes(intersectSteeringScopes(entry.revision.scope, steeringEvaluationScope(entry.inclusion_evaluation)!),
      unionSteeringScopes(entry.reasons.map((reason) => steeringEvaluationScope(reason.evaluation)!))),
  }));
  for (const entry of resources) if (steeringScopeEmpty(entry.scope)) diagnostics.push({ code: "steering-scope-invalid", severity: "error", resource: entry.revision.identity, detail: "empty-applicable-region" });
  for (const entry of resources) if (resources.filter((other) => other.revision.identity.id === entry.revision.identity.id).length > 1)
    diagnostics.push({ code: "steering-duplicate-resource", severity: "error", resource: entry.revision.identity, detail: "multiple-active-revisions" });
  const rules: SteeringApplicableRule[] = [];
  for (const entry of resources) for (const rule of entry.revision.rules) {
    const resource = entry.revision.identity, declaredScope = rule.scope ?? entry.revision.scope;
    const availability = rule.inclusion?.availability ?? entry.revision.inclusion.availability;
    if (rule.status === "deprecated") { omissions.push({ resource, rule: rule.id, availability, reason: "deprecated" }); continue; }
    const scopeEvaluation = evaluateSteeringExpression(declaredScope, inputs.action);
    const inclusion = evaluateSteeringExpression(rule.inclusion?.selector ?? { kind: "always" }, inputs.action, isManual(resource, rule.id));
    evaluationIssues(scopeEvaluation, resource, rule.id); evaluationIssues(inclusion, resource, rule.id);
    if (scopeEvaluation.outcome === "error" || inclusion.outcome === "error") continue;
    if (scopeEvaluation.outcome === "miss" || inclusion.outcome === "miss") {
      omissions.push({ resource, rule: rule.id, availability, reason: scopeEvaluation.outcome === "miss" ? "scope-miss" :
        rule.inclusion && containsManualSelector(rule.inclusion.selector) && !isManual(resource, rule.id) ? "manual-unselected" : "selector-miss" });
      continue;
    }
    const scope = intersectSteeringScopes(intersectSteeringScopes(declaredScope, entry.scope), steeringEvaluationScope(inclusion)!);
    if (steeringScopeEmpty(scope)) { diagnostics.push({ code: "steering-scope-invalid", severity: "error", resource, rule: rule.id, detail: "empty-applicable-region" }); continue; }
    rules.push({ resource, rule: rule.id, declaration: rule, scope, semantics: rule.semantics, authority: rule.authority,
      override_policy: rule.override_policy, enforcement: rule.enforcement, tier: entry.tier, resource_order: entry.order,
      scope_evaluation: scopeEvaluation, inclusion_evaluation: inclusion });
  }
  const composed = composeSteeringRules(resources, rules, inputs);
  diagnostics.push(...composed.issues);
  if (diagnostics.some((issue) => issue.severity === "error")) diagnostics.push({ code: "steering-conflict-unresolved", severity: "error" });
  const trace = { inputs, hierarchy_order: hierarchy.order.map((resource) => resource.identity), included_resources: resources,
    applicable_rules: rules, omissions: distinct(omissions), overrides: composed.decisions, shadowed_rules: composed.shadowed };
  if (diagnostics.some((issue) => issue.severity === "error")) return finish({ ...resultBase, ...trace, status: "conflicted", diagnostics });
  return finish({ ...resultBase, ...trace, status: "resolved", effective_rules: composed.effective, enforcement: composed.enforcement, diagnostics });
}
