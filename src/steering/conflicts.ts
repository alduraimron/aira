import { canonical, compareText, exact } from "../spec/domain/primitives";
import { enforcementBindingIdentity, isRequiredEnforcementBinding } from "./authority";
import {
  distinct, ruleReference, ruleSubject,
  type SteeringApplicableRule, type SteeringEffectiveRule, type SteeringIncludedResource, type SteeringOverrideDecision,
  type SteeringResolutionInputs, type SteeringResolutionIssue, type SteeringResolvedBinding, type SteeringRuleRegion,
} from "./resolution-contract";
import { compareSteeringScopes, intersectSteeringScopes, steeringExpressionImplies, steeringScopesDisjoint } from "./scope";
import type { SteeringEnforcementBinding, SteeringRule } from "./types";

const authorityRank = { descriptive: 0, normative: 1, enforceable: 2 } as const;
export function compatibleSteeringSemantics(a: SteeringRule["semantics"], b: SteeringRule["semantics"]): boolean {
  if (a.key !== b.key) return true;
  if (a.effect === b.effect) return a.effect === "forbid" || exact(a.value, b.value);
  // These two effects have an explicitly defined safe unequal-value composition. Other mixtures fail closed.
  return ((a.effect === "require" && b.effect === "forbid") || (b.effect === "require" && a.effect === "forbid")) && !exact(a.value, b.value);
}
function provableStrengthening(source: SteeringApplicableRule, target: SteeringApplicableRule): boolean {
  return exact(source.semantics, target.semantics) ||
    (source.semantics.effect === "forbid" && target.semantics.effect === "forbid");
}
const sameRule = (a: SteeringApplicableRule, b: { resource: SteeringApplicableRule["resource"]; rule: SteeringApplicableRule["rule"] }): boolean =>
  a.rule === b.rule && exact(a.resource, b.resource);

export function composeSteeringRules(resources: readonly SteeringIncludedResource[], rules: readonly SteeringApplicableRule[], inputs: SteeringResolutionInputs) {
  const issues: SteeringResolutionIssue[] = [], decisions: SteeringOverrideDecision[] = [];
  for (const entry of resources) {
    for (const declaration of entry.revision.composition.overrides) {
      const targetRules = rules.filter((rule) => exact(rule.resource, declaration.target.resource) &&
        (declaration.target.rule === undefined || rule.rule === declaration.target.rule));
      const sourceRules = rules.filter((rule) => exact(rule.resource, entry.revision.identity));
      const issue = (code: SteeringResolutionIssue["code"], involved: readonly SteeringApplicableRule[], detail?: string): void => {
        issues.push({ code, severity: "error", resource: entry.revision.identity, related: [declaration.target.resource],
          ...(involved[0] ? { semantic_key: involved[0].semantics.key } : {}), rules: involved.map(ruleSubject), override: declaration,
          ...(detail ? { detail } : {}) });
      };
      if (!targetRules.length) { issue("steering-override-target-missing", [], "target-not-applicable"); continue; }
      for (const target of targetRules) {
        const sources = sourceRules.filter((source) => source.semantics.key === target.semantics.key);
        if (sources.length !== 1 || (declaration.target.rule === undefined && targetRules.filter((other) => other.semantics.key === target.semantics.key).length !== 1)) {
          issue("steering-override-ambiguous", [target, ...sources], "unique-semantic-source-and-target-required"); continue;
        }
        const source = sources[0]!, involved = [target, source], start = issues.length;
        const targetEntry = resources.find((resource) => exact(resource.revision.identity, target.resource));
        if (entry.revision.provenance.kind !== "project" || targetEntry?.revision.provenance.kind !== "project" ||
          !entry.revision.composition.parents.some((parent) => exact(parent, target.resource)))
          issue("steering-override-not-allowed", involved, "native-exact-parent-required");
        const relation = compareSteeringScopes(source.scope, target.scope);
        const declaredRelation = compareSteeringScopes(source.declaration.scope ?? entry.revision.scope,
          target.declaration.scope ?? targetEntry!.revision.scope);
        if ((relation !== "equal" && relation !== "narrower") || (declaredRelation !== "equal" && declaredRelation !== "narrower"))
          issue("steering-scope-widening", involved, "override-scope-unproven");
        if (target.override_policy === "sealed") issue("steering-sealed-rule-override", involved);
        else if (target.override_policy === "narrower-scope" && (declaredRelation !== "narrower" || relation !== "narrower" || declaration.mode === "replace"))
          issue("steering-override-not-allowed", involved, "explicit-narrower-specialization-required");
        else if (target.override_policy === "explicit-replacement" && declaration.mode !== "replace")
          issue("steering-override-not-allowed", involved, "replacement-mode-required");
        if (authorityRank[source.authority] < authorityRank[target.authority]) issue("steering-authority-conflict", involved, "authority-downgrade");
        const required = target.enforcement.filter(isRequiredEnforcementBinding);
        if (required.some((binding) => !source.enforcement.some((other) => exact(binding, other))))
          issue("steering-enforcement-weakening", involved, "required-binding-not-retained");
        if (target.authority === "enforceable" && (source.authority !== "enforceable" || declaration.mode !== "strengthen" || !provableStrengthening(source, target)))
          issue("steering-enforcement-weakening", involved, "only-provable-enforceable-strengthening");
        if (declaration.mode === "strengthen" && !provableStrengthening(source, target))
          issue("steering-override-not-allowed", involved, "semantic-strengthening-unproven");
        if (issues.length === start && (relation === "equal" || relation === "narrower")) decisions.push({
          source: ruleReference(source), target: ruleReference(target), declaration, scope: source.scope, relation,
          // Strengthening composes; it never erases an upstream constraint or its policy.
          disposition: declaration.mode === "strengthen" ? "compose" : "supersede",
        });
      }
    }
  }
  const referenceOrder = (ref: SteeringOverrideDecision["source"]): number => rules.find((rule) => sameRule(rule, ref))!.resource_order;
  const compareDecisions = (a: SteeringOverrideDecision, b: SteeringOverrideDecision): number =>
    referenceOrder(a.source) - referenceOrder(b.source) || compareText(a.source.rule, b.source.rule) ||
    referenceOrder(a.target) - referenceOrder(b.target) || compareText(a.target.rule, b.target.rule) || compareText(canonical(a), canonical(b));
  const stableDecisions = distinct(decisions).sort(compareDecisions);
  const regions: SteeringRuleRegion[] = rules.map((rule) => ({ ...{ source: ruleReference(rule) }, scope: rule.scope,
    excluded_scopes: distinct(stableDecisions.filter((decision) => decision.disposition === "supersede" && sameRule(rule, decision.target)).map((decision) => decision.scope)),
  }));
  const activeRegion = (region: SteeringRuleRegion): boolean => !region.excluded_scopes.some((excluded) => steeringExpressionImplies(region.scope, excluded));
  const overlapRemains = (a: SteeringRuleRegion, b: SteeringRuleRegion): boolean => {
    if (!activeRegion(a) || !activeRegion(b) || steeringScopesDisjoint(a.scope, b.scope)) return false;
    const overlap = intersectSteeringScopes(a.scope, b.scope);
    return ![...a.excluded_scopes, ...b.excluded_scopes].some((excluded) => steeringExpressionImplies(overlap, excluded));
  };
  // Compare residual regions, not a last-winner list. A partial override cannot erase the parent's other paths.
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i]!, b = rules[j]!;
    if (!compatibleSteeringSemantics(a.semantics, b.semantics) && overlapRemains(regions[i]!, regions[j]!)) issues.push({
      code: "steering-semantic-conflict", severity: "error", semantic_key: a.semantics.key, rules: [ruleSubject(a), ruleSubject(b)],
      detail: compareSteeringScopes(a.scope, b.scope),
    });
  }
  // Two declarations cannot independently displace the same target on unordered overlapping scopes,
  // even when their proposed values agree. Identical duplicate decisions have already been coalesced.
  for (let i = 0; i < stableDecisions.length; i++) for (const b of stableDecisions.slice(i + 1)) {
    const a = stableDecisions[i]!;
    if (!exact(a.target, b.target) || exact(a.source, b.source) || steeringScopesDisjoint(a.scope, b.scope)) continue;
    const linked = stableDecisions.some((decision) => (exact(decision.source, a.source) && exact(decision.target, b.source)) ||
      (exact(decision.source, b.source) && exact(decision.target, a.source)));
    if (!linked) issues.push({ code: "steering-override-ambiguous", severity: "error", resource: a.target.resource,
      rule: a.target.rule, rules: rules.filter((rule) => sameRule(rule, a.source) || sameRule(rule, b.source) || sameRule(rule, a.target)).map(ruleSubject), detail: "competing-overrides" });
  }

  const groups = new Map<string, { rules: SteeringApplicableRule[]; regions: SteeringRuleRegion[] }>();
  rules.forEach((rule, i) => {
    if (!activeRegion(regions[i]!)) return;
    // Do not promote prose in a different region to an enforceable authority label.
    const key = canonical({ semantics: rule.semantics, authority: rule.authority });
    const group = groups.get(key) ?? { rules: [], regions: [] };
    group.rules.push(rule); group.regions.push(regions[i]!); groups.set(key, group);
  });
  const effective: SteeringEffectiveRule[] = [...groups.values()].map((group) => ({
    semantics: group.rules[0]!.semantics, authority: group.rules[0]!.authority, contributors: group.rules,
    regions: group.regions, enforcement: distinct(group.rules.flatMap((rule) => rule.enforcement)),
  })).sort((a, b) => a.contributors[0]!.resource_order - b.contributors[0]!.resource_order ||
    compareText(a.semantics.key, b.semantics.key) || compareText(a.semantics.effect, b.semantics.effect) ||
    compareText(canonical(a.semantics.value), canonical(b.semantics.value)) || compareText(a.authority, b.authority));

  // Retain every applicable binding, including default restrictions and displaced-rule restrictions.
  // Capability-policy references remain layers for composeCapabilityPolicies, never flattened permissions.
  const bindings = new Map<string, { binding: SteeringEnforcementBinding; sources: SteeringResolvedBinding["sources"][number][] }>();
  const addBinding = (binding: SteeringEnforcementBinding, source: SteeringResolvedBinding["sources"][number]): void => {
    const key = canonical(binding), current = bindings.get(key) ?? { binding, sources: [] };
    current.sources.push(source); bindings.set(key, current);
  };
  for (const rule of rules) for (const binding of rule.enforcement) addBinding(binding, { ...ruleReference(rule), scope: rule.scope });
  for (const resource of resources) for (const binding of resource.revision.default_enforcement)
    addBinding(binding, { resource: resource.revision.identity, scope: resource.scope });
  const enforcement: SteeringResolvedBinding[] = [...bindings.values()].map((entry) => ({ ...entry, sources: distinct(entry.sources) }))
    .sort((a, b) => compareText(enforcementBindingIdentity(a.binding), enforcementBindingIdentity(b.binding)) || compareText(canonical(a.binding), canonical(b.binding)));
  // Mechanism identity integrity is global, even across scopes: an immutable revision cannot have two hashes.
  const mechanismKey = (binding: SteeringEnforcementBinding): string => {
    if (binding.kind === "verifier" || binding.kind === "repository-check") return `verifier:${binding.verifier.id}@${binding.verifier.revision}`;
    if (binding.kind === "extension") return `profile:${binding.mechanism.id}@${binding.mechanism.revision}`;
    return enforcementBindingIdentity(binding);
  };
  const mechanismHash = (binding: SteeringEnforcementBinding): string => binding.kind === "capability-policy" ? binding.policy.hash :
    binding.kind === "extension" ? binding.mechanism.hash : binding.verifier.hash;
  const allBindings = [...enforcement.map((entry) => entry.binding), ...inputs.available_enforcement];
  for (const binding of allBindings) {
    if (binding.kind === "extension" && allBindings.some((other) => other.kind === "extension" &&
      mechanismKey(other) === mechanismKey(binding) && other.contract !== binding.contract))
      issues.push({ code: "steering-enforcement-conflict", severity: "error", detail: mechanismKey(binding) });
    if (allBindings.some((other) => mechanismKey(other) === mechanismKey(binding) && mechanismHash(other) !== mechanismHash(binding)))
      issues.push({ code: "steering-enforcement-conflict", severity: "error", detail: mechanismKey(binding) });
  }
  for (const entry of enforcement) {
    if (entry.binding.kind === "extension" && entry.binding.use === "required" && !inputs.supported_contracts.includes(entry.binding.contract))
      issues.push({ code: "steering-compatibility-invalid", severity: "error", related: entry.sources.map((source) => source.resource), detail: entry.binding.contract });
    // Same binding identity with changed use/contract is not silently upgraded or downgraded.
    if (enforcement.some((other) => enforcementBindingIdentity(other.binding) === enforcementBindingIdentity(entry.binding) && !exact(other.binding, entry.binding)))
      issues.push({ code: "steering-enforcement-conflict", severity: "error", related: entry.sources.map((source) => source.resource), detail: enforcementBindingIdentity(entry.binding) });
    if (isRequiredEnforcementBinding(entry.binding) && !inputs.available_enforcement.some((binding) => exact(binding, entry.binding)))
      issues.push({ code: "steering-enforcement-missing", severity: "error", related: entry.sources.map((source) => source.resource), detail: enforcementBindingIdentity(entry.binding) });
  }
  const shadowed = stableDecisions.filter((decision) => decision.disposition === "supersede").map((decision) => ({
    target: decision.target, by: decision.source, scope: decision.scope, coverage: decision.relation === "equal" ? "full" as const : "partial" as const,
  }));
  return { issues, decisions: stableDecisions, effective, enforcement, shadowed };
}
