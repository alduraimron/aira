import { z } from "zod";
import { canonicalBytes } from "../canonical-json";
import { canonical, compareText, exact, type DeepReadonly } from "../spec/domain/primitives";
import {
  isRequiredEnforcementBinding,
  steeringAuthoritySchema,
  steeringEnforcementBindingSchema,
  versionedContractSchema,
  type SteeringEnforcementBindingValue,
} from "./authority";
import { steeringInclusionSchema, steeringScopeSchema } from "./applicability";
import {
  steeringCustomCategorySchema,
  steeringResourceIdSchema,
  steeringRevisionReferenceSchema,
  steeringSemanticKeySchema,
  type SteeringResourceId,
  type SteeringSemanticKey,
} from "./ids";
import {
  freezeResolution,
  sorted,
  steeringEvaluationSchema,
  steeringRuleReferenceSchema,
  steeringRuleRegionSchema,
} from "./resolution-contract";
import {
  steeringProjectNamespaceSchema,
  steeringProvenanceSchema,
  steeringResourceKindSchema,
  steeringRuleSemanticsSchema,
} from "./schema";
import { steeringScopesDisjoint } from "./scope";
import {
  STEERING_SNAPSHOT_SCHEMA,
  steeringSnapshotReference,
  steeringSnapshotReferenceSchema,
  steeringSnapshotSchema,
  validateSteeringSnapshot,
  type SteeringSnapshot,
  type SteeringSnapshotReference,
} from "./snapshot";
import {
  steeringDependencySchema,
  validateSteeringDependency,
  type SteeringDependency,
} from "./dependency";

export const STEERING_CHANGE_SET_SCHEMA = "aira.dev/steering-change-set/v1" as const;

const canonicalSet = (values: readonly unknown[]): boolean => values.every((value, index) =>
  index === 0 || compareText(canonical(values[index - 1]), canonical(value)) < 0);
const steeringResourceObservationSchema = z.strictObject({
  identity: steeringRevisionReferenceSchema,
  kind: steeringResourceKindSchema,
  custom_kind: steeringCustomCategorySchema.optional(),
  provenance: steeringProvenanceSchema,
  resolved_scope: steeringScopeSchema,
  inclusion: z.strictObject({
    declaration: steeringInclusionSchema,
    reasons: z.array(z.strictObject({
      kind: z.enum(["selection", "manual", "parent"]),
      from: steeringRevisionReferenceSchema.optional(),
      evaluation: steeringEvaluationSchema,
    })),
    scope_evaluation: steeringEvaluationSchema,
    inclusion_evaluation: steeringEvaluationSchema,
  }),
  default_authority: steeringAuthoritySchema,
  default_enforcement: z.array(steeringEnforcementBindingSchema).refine(canonicalSet),
});
const steeringEffectiveObservationSchema = z.strictObject({
  semantics: steeringRuleSemanticsSchema,
  authority: steeringAuthoritySchema,
  contributors: z.array(steeringRuleReferenceSchema).min(1).refine(canonicalSet),
  regions: z.array(steeringRuleRegionSchema).min(1).refine(canonicalSet),
  enforcement: z.array(steeringEnforcementBindingSchema).refine(canonicalSet),
});
const steeringChangeStateSchema = z.strictObject({
  resources: z.array(steeringResourceObservationSchema).refine(canonicalSet),
  effective_rules: z.array(steeringEffectiveObservationSchema).refine(canonicalSet),
});
export const steeringChangeKinds = [
  "resource-added",
  "resource-removed",
  "resource-revision-changed",
  "semantic-rule-added",
  "semantic-rule-removed",
  "semantic-value-changed",
  "authority-changed",
  "scope-changed",
  "inclusion-changed",
  "enforcement-changed",
  "provenance-changed",
  "resolution-input-changed",
  "compatibility-observation-changed",
  "resolution-decision-changed",
  "resolver-policy-changed",
] as const;
export const steeringChangeDimensionSchema = z.enum([
  "action",
  "resource-selections",
  "manual-selections",
  "supported-contracts",
  "available-enforcement",
  "hierarchy-order",
  "applicable-rules",
  "overrides",
  "shadowed-rules",
  "omissions",
  "diagnostics",
  "other",
]);
export const steeringChangeSchema = z.strictObject({
  kind: z.enum(steeringChangeKinds),
  resource: steeringResourceIdSchema.optional(),
  semantic_key: steeringSemanticKeySchema.optional(),
  previous: steeringChangeStateSchema,
  current: steeringChangeStateSchema,
  previous_policy: versionedContractSchema.optional(),
  current_policy: versionedContractSchema.optional(),
  dimension: steeringChangeDimensionSchema.optional(),
}).superRefine((change, ctx) => {
  const policy = change.kind === "resolver-policy-changed";
  const resource = change.kind.startsWith("resource-") ||
    (["authority-changed", "scope-changed", "inclusion-changed", "enforcement-changed", "provenance-changed"] as string[])
      .includes(change.kind) && change.resource !== undefined;
  const semantic = change.kind.startsWith("semantic-") ||
    (["authority-changed", "scope-changed", "enforcement-changed", "provenance-changed"] as string[])
      .includes(change.kind) && change.semantic_key !== undefined;
  const snapshot = ["resolution-input-changed", "compatibility-observation-changed", "resolution-decision-changed"]
    .includes(change.kind);
  if (policy !== (change.previous_policy !== undefined && change.current_policy !== undefined))
    ctx.addIssue({ code: "custom", message: "invalid-steering-policy-change" });
  if (snapshot !== (change.dimension !== undefined))
    ctx.addIssue({ code: "custom", message: "invalid-steering-snapshot-change-dimension" });
  if (!policy && !resource && !semantic && !snapshot)
    ctx.addIssue({ code: "custom", message: "invalid-steering-change-target" });
  if (change.resource !== undefined && change.semantic_key !== undefined)
    ctx.addIssue({ code: "custom", message: "ambiguous-steering-change-target" });

  const previousResources = change.previous.resources, currentResources = change.current.resources;
  const previousRules = change.previous.effective_rules, currentRules = change.current.effective_rules;
  const invalid = (message: string): void => ctx.addIssue({ code: "custom", message });
  if (policy) {
    if (change.previous_policy === change.current_policy || previousResources.length || currentResources.length ||
      previousRules.length || currentRules.length) invalid("invalid-steering-policy-change-state");
  } else if (snapshot) {
    const dimensions = change.kind === "resolution-input-changed" ? ["action", "resource-selections", "manual-selections"] :
      change.kind === "compatibility-observation-changed" ? ["supported-contracts", "available-enforcement"] :
        ["hierarchy-order", "applicable-rules", "overrides", "shadowed-rules", "omissions", "diagnostics", "other"];
    if (change.dimension === undefined || !dimensions.includes(change.dimension))
      invalid("invalid-steering-snapshot-change-dimension");
    if (change.resource !== undefined || change.semantic_key !== undefined || previousResources.length || currentResources.length ||
      previousRules.length || currentRules.length || change.previous_policy !== undefined || change.current_policy !== undefined)
      invalid("invalid-steering-snapshot-change-state");
  } else if (resource) {
    if (previousRules.length || currentRules.length ||
      [...previousResources, ...currentResources].some((observation) => observation.identity.id !== change.resource))
      invalid("invalid-steering-resource-change-state");
    if (change.kind === "resource-added" && (previousResources.length !== 0 || currentResources.length !== 1))
      invalid("invalid-steering-resource-addition");
    else if (change.kind === "resource-removed" && (previousResources.length !== 1 || currentResources.length !== 0))
      invalid("invalid-steering-resource-removal");
    else if (!change.kind.startsWith("resource-") && (previousResources.length !== 1 || currentResources.length !== 1))
      invalid("incomplete-steering-resource-change");
    else if (change.kind === "resource-revision-changed" && (previousResources.length !== 1 || currentResources.length !== 1 ||
      exact(previousResources[0]!.identity, currentResources[0]!.identity)))
      invalid("invalid-steering-resource-revision-change");
    if (previousResources.length === 1 && currentResources.length === 1) {
      const before = previousResources[0]!, after = currentResources[0]!;
      if (change.kind === "provenance-changed" && exact(before.provenance, after.provenance)) invalid("empty-steering-provenance-change");
      if (change.kind === "authority-changed" && before.default_authority === after.default_authority) invalid("empty-steering-authority-change");
      if (change.kind === "scope-changed" && exact(before.resolved_scope, after.resolved_scope)) invalid("empty-steering-scope-change");
      if (change.kind === "inclusion-changed" && exact(before.inclusion, after.inclusion)) invalid("empty-steering-inclusion-change");
      if (change.kind === "enforcement-changed" && exact(before.default_enforcement, after.default_enforcement))
        invalid("empty-steering-enforcement-change");
    }
  } else if (semantic) {
    if (previousResources.length || currentResources.length || [...previousRules, ...currentRules].some((observation) =>
      observation.semantics.key !== change.semantic_key)) invalid("invalid-steering-semantic-change-state");
    if (change.kind === "semantic-rule-added" && (previousRules.length !== 0 || currentRules.length === 0))
      invalid("invalid-steering-semantic-addition");
    else if (change.kind === "semantic-rule-removed" && (previousRules.length === 0 || currentRules.length !== 0))
      invalid("invalid-steering-semantic-removal");
    else if (!change.kind.startsWith("semantic-rule-") && (previousRules.length === 0 || currentRules.length === 0))
      invalid("incomplete-steering-semantic-change");
    if (previousRules.length && currentRules.length) {
      const semanticValues = (rules: typeof previousRules): unknown => sorted(rules.map((rule) => ({
        effect: rule.semantics.effect, value: rule.semantics.value,
      })));
      const authoritySetValues = (rules: typeof previousRules): unknown =>
        sorted([...new Set(rules.map((rule) => rule.authority))]);
      const authorityValues = (rules: typeof previousRules): unknown => sorted(rules.map((rule) => ({
        semantics: rule.semantics, authority: rule.authority,
      })));
      const scopeSetValues = (rules: typeof previousRules): unknown => sorted(rules.map((rule) =>
        sorted(rule.regions.map((region) => ({ scope: region.scope, excluded_scopes: region.excluded_scopes })))));
      const scopeValues = (rules: typeof previousRules): unknown => sorted(rules.map((rule) => ({
        semantics: rule.semantics,
        regions: sorted(rule.regions.map((region) => ({ scope: region.scope, excluded_scopes: region.excluded_scopes }))),
      })));
      const enforcementSetValues = (rules: typeof previousRules): unknown => sorted([
        ...new Map(rules.flatMap((rule) => rule.enforcement).map((binding) => [canonical(binding), binding])).values(),
      ]);
      const enforcementValues = (rules: typeof previousRules): unknown => sorted(rules.map((rule) => ({
        semantics: rule.semantics, enforcement: rule.enforcement,
      })));
      const contributorValues = (rules: typeof previousRules): unknown => sorted(rules.flatMap((rule) => rule.contributors));
      const sameSemantic = exact(semanticValues(previousRules), semanticValues(currentRules));
      if (change.kind === "semantic-value-changed" && sameSemantic)
        invalid("empty-steering-semantic-value-change");
      if (change.kind === "authority-changed" && exact(authoritySetValues(previousRules), authoritySetValues(currentRules)) &&
        (!sameSemantic || exact(authorityValues(previousRules), authorityValues(currentRules))))
        invalid("empty-steering-authority-change");
      if (change.kind === "scope-changed" && exact(scopeSetValues(previousRules), scopeSetValues(currentRules)) &&
        (!sameSemantic || exact(scopeValues(previousRules), scopeValues(currentRules))))
        invalid("empty-steering-scope-change");
      if (change.kind === "enforcement-changed" && exact(enforcementSetValues(previousRules), enforcementSetValues(currentRules)) &&
        (!sameSemantic || exact(enforcementValues(previousRules), enforcementValues(currentRules))))
        invalid("empty-steering-enforcement-change");
      if (change.kind === "provenance-changed" && exact(contributorValues(previousRules), contributorValues(currentRules)))
        invalid("empty-steering-provenance-change");
    }
  }
});
export const steeringChangeSetSchema = z.strictObject({
  schema: z.literal(STEERING_CHANGE_SET_SCHEMA),
  comparison: z.literal("complete-resolved-steering/v1"),
  snapshot_contract: z.literal(STEERING_SNAPSHOT_SCHEMA),
  project: steeringProjectNamespaceSchema,
  previous: z.strictObject({ snapshot: steeringSnapshotReferenceSchema, policy: versionedContractSchema }),
  current: z.strictObject({ snapshot: steeringSnapshotReferenceSchema, policy: versionedContractSchema }),
  changes: z.array(steeringChangeSchema).refine(canonicalSet, "noncanonical-steering-change-order"),
}).superRefine((changeSet, ctx) => {
  const sameSnapshot = exact(changeSet.previous.snapshot, changeSet.current.snapshot);
  const policyChanged = changeSet.previous.policy !== changeSet.current.policy;
  if (sameSnapshot && (changeSet.changes.length > 0 || policyChanged))
    ctx.addIssue({ code: "custom", message: "steering-change-set-identical-snapshot" });
  if (!sameSnapshot && changeSet.changes.length === 0)
    ctx.addIssue({ code: "custom", message: "steering-change-set-incomplete" });
  if (policyChanged !== changeSet.changes.some((change) => change.kind === "resolver-policy-changed"))
    ctx.addIssue({ code: "custom", message: "steering-policy-change-observation-missing" });
});

export type SteeringResourceObservation = DeepReadonly<z.infer<typeof steeringResourceObservationSchema>>;
export type SteeringEffectiveObservation = DeepReadonly<z.infer<typeof steeringEffectiveObservationSchema>>;
export type SteeringChange = DeepReadonly<z.infer<typeof steeringChangeSchema>>;
export type SteeringChangeSet = DeepReadonly<z.infer<typeof steeringChangeSetSchema>>;

export const steeringChangeIssueCodes = [
  "steering-change-input-invalid",
  "steering-change-project-mismatch",
  "steering-change-snapshot-invalid",
  "steering-change-comparison-incomplete",
] as const;
export type SteeringChangeIssueCode = typeof steeringChangeIssueCodes[number];
export interface SteeringChangeIssue { readonly code: SteeringChangeIssueCode; readonly subject?: string }
export type SteeringChangeSetResult =
  | { readonly ok: true; readonly value: SteeringChangeSet }
  | { readonly ok: false; readonly issues: readonly SteeringChangeIssue[] };

const emptyState = (): z.infer<typeof steeringChangeStateSchema> => ({ resources: [], effective_rules: [] });
const state = (resources: readonly SteeringResourceObservation[] = [],
  effective: readonly SteeringEffectiveObservation[] = []): z.infer<typeof steeringChangeStateSchema> => ({
  resources: sorted(resources) as z.infer<typeof steeringResourceObservationSchema>[],
  effective_rules: sorted(effective) as z.infer<typeof steeringEffectiveObservationSchema>[],
});
function resourceObservation(entry: SteeringSnapshot["semantic"]["resources"][number]): SteeringResourceObservation {
  return {
    identity: entry.revision.identity,
    kind: entry.revision.kind,
    ...(entry.revision.custom_kind === undefined ? {} : { custom_kind: entry.revision.custom_kind }),
    provenance: entry.revision.provenance,
    resolved_scope: entry.scope,
    inclusion: { declaration: entry.revision.inclusion, reasons: entry.reasons,
      scope_evaluation: entry.scope_evaluation, inclusion_evaluation: entry.inclusion_evaluation },
    default_authority: entry.revision.default_authority,
    default_enforcement: sorted(entry.revision.default_enforcement),
  };
}
function effectiveObservation(rule: SteeringSnapshot["semantic"]["effective_rules"][number]): SteeringEffectiveObservation {
  return {
    semantics: rule.semantics,
    authority: rule.authority,
    contributors: sorted(rule.contributors.map((contributor) => ({ resource: contributor.resource, rule: contributor.rule }))),
    regions: sorted(rule.regions.map((region) => ({ ...region, excluded_scopes: sorted(region.excluded_scopes) }))),
    enforcement: sorted(rule.enforcement),
  };
}
const resourceMap = (snapshot: SteeringSnapshot): Map<string, SteeringResourceObservation> =>
  new Map(snapshot.semantic.resources.map(resourceObservation).map((observation) => [observation.identity.id, observation]));
function effectiveMap(snapshot: SteeringSnapshot): Map<string, SteeringEffectiveObservation[]> {
  const map = new Map<string, SteeringEffectiveObservation[]>();
  for (const observation of snapshot.semantic.effective_rules.map(effectiveObservation)) {
    const current = map.get(observation.semantics.key) ?? [];
    current.push(observation); map.set(observation.semantics.key, sorted(current));
  }
  return map;
}
const semanticCore = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted(rules.map((rule) => ({ effect: rule.semantics.effect, value: rule.semantics.value })));
const authoritySet = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted([...new Set(rules.map((rule) => rule.authority))]);
const authorities = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted(rules.map((rule) => ({ semantics: rule.semantics, authority: rule.authority })));
const regionMeaning = (rule: SteeringEffectiveObservation): unknown => sorted(rule.regions.map((region) => ({
  scope: region.scope,
  excluded_scopes: region.excluded_scopes,
})));
const scopeSet = (rules: readonly SteeringEffectiveObservation[]): unknown => sorted(rules.map(regionMeaning));
const scopes = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted(rules.map((rule) => ({ semantics: rule.semantics, regions: regionMeaning(rule) })));
const enforcementSet = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted([...new Map(rules.flatMap((rule) => rule.enforcement).map((binding) => [canonical(binding), binding])).values()]);
const enforcement = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted(rules.map((rule) => ({ semantics: rule.semantics, enforcement: rule.enforcement })));
const contributors = (rules: readonly SteeringEffectiveObservation[]): unknown =>
  sorted(rules.flatMap((rule) => rule.contributors));

function deriveChanges(previous: SteeringSnapshot, current: SteeringSnapshot): SteeringChange[] {
  const changes: z.infer<typeof steeringChangeSchema>[] = [];
  const beforeResources = resourceMap(previous), afterResources = resourceMap(current);
  for (const id of [...new Set([...beforeResources.keys(), ...afterResources.keys()])].sort(compareText)) {
    const before = beforeResources.get(id), after = afterResources.get(id), resource = steeringResourceIdSchema.parse(id);
    const add = (kind: typeof steeringChangeKinds[number]): void => {
      changes.push({ kind, resource, previous: state(before ? [before] : []), current: state(after ? [after] : []) });
    };
    if (!before) { add("resource-added"); continue; }
    if (!after) { add("resource-removed"); continue; }
    if (!exact(before.identity, after.identity)) add("resource-revision-changed");
    if (!exact(before.provenance, after.provenance)) add("provenance-changed");
    if (before.default_authority !== after.default_authority) add("authority-changed");
    if (!exact(before.resolved_scope, after.resolved_scope)) add("scope-changed");
    if (!exact(before.inclusion, after.inclusion)) add("inclusion-changed");
    if (!exact(before.default_enforcement, after.default_enforcement)) add("enforcement-changed");
  }

  const beforeEffective = effectiveMap(previous), afterEffective = effectiveMap(current);
  for (const rawKey of [...new Set([...beforeEffective.keys(), ...afterEffective.keys()])].sort(compareText)) {
    const before = beforeEffective.get(rawKey) ?? [], after = afterEffective.get(rawKey) ?? [];
    const semanticKey = steeringSemanticKeySchema.parse(rawKey);
    const add = (kind: typeof steeringChangeKinds[number], oldRules = before, newRules = after): void => {
      changes.push({ kind, semantic_key: semanticKey, previous: state([], oldRules), current: state([], newRules) });
    };
    if (!before.length) { add("semantic-rule-added"); continue; }
    if (!after.length) { add("semantic-rule-removed"); continue; }
    const sameSemanticCore = exact(semanticCore(before), semanticCore(after));
    if (!sameSemanticCore) add("semantic-value-changed");
    if (!exact(authoritySet(before), authoritySet(after)) || sameSemanticCore && !exact(authorities(before), authorities(after)))
      add("authority-changed");
    if (!exact(scopeSet(before), scopeSet(after)) || sameSemanticCore && !exact(scopes(before), scopes(after)))
      add("scope-changed");
    if (!exact(enforcementSet(before), enforcementSet(after)) || sameSemanticCore && !exact(enforcement(before), enforcement(after)))
      add("enforcement-changed");
    if (!exact(contributors(before), contributors(after))) add("provenance-changed");
  }
  const addSnapshotChange = (kind: "resolution-input-changed" | "compatibility-observation-changed" |
    "resolution-decision-changed", dimension: z.infer<typeof steeringChangeDimensionSchema>): void => {
    changes.push({ kind, dimension, previous: emptyState(), current: emptyState() });
  };
  if (!exact(previous.semantic.selectors.action, current.semantic.selectors.action))
    addSnapshotChange("resolution-input-changed", "action");
  if (!exact(previous.semantic.selectors.resources, current.semantic.selectors.resources))
    addSnapshotChange("resolution-input-changed", "resource-selections");
  if (!exact(previous.semantic.selectors.manual, current.semantic.selectors.manual))
    addSnapshotChange("resolution-input-changed", "manual-selections");
  if (!exact(previous.semantic.compatibility.supported_contracts, current.semantic.compatibility.supported_contracts))
    addSnapshotChange("compatibility-observation-changed", "supported-contracts");
  if (!exact(previous.semantic.compatibility.available_enforcement, current.semantic.compatibility.available_enforcement))
    addSnapshotChange("compatibility-observation-changed", "available-enforcement");
  if (!exact(previous.semantic.hierarchy_order, current.semantic.hierarchy_order))
    addSnapshotChange("resolution-decision-changed", "hierarchy-order");
  if (!exact(previous.semantic.applicable_rules, current.semantic.applicable_rules))
    addSnapshotChange("resolution-decision-changed", "applicable-rules");
  if (!exact(previous.semantic.decisions.overrides, current.semantic.decisions.overrides))
    addSnapshotChange("resolution-decision-changed", "overrides");
  if (!exact(previous.semantic.decisions.shadowed_rules, current.semantic.decisions.shadowed_rules))
    addSnapshotChange("resolution-decision-changed", "shadowed-rules");
  if (!exact(previous.semantic.decisions.omissions, current.semantic.decisions.omissions))
    addSnapshotChange("resolution-decision-changed", "omissions");
  if (!exact(previous.semantic.decisions.diagnostics, current.semantic.decisions.diagnostics))
    addSnapshotChange("resolution-decision-changed", "diagnostics");

  if (previous.semantic.resolver.policy !== current.semantic.resolver.policy) changes.push({
    kind: "resolver-policy-changed",
    previous: emptyState(),
    current: emptyState(),
    previous_policy: previous.semantic.resolver.policy,
    current_policy: current.semantic.resolver.policy,
  });
  if (!exact(previous.semantic, current.semantic) && changes.length === 0)
    addSnapshotChange("resolution-decision-changed", "other");
  return sorted(changes);
}

export function compareSteeringSnapshots(previous: SteeringSnapshot, current: SteeringSnapshot): SteeringChangeSetResult {
  if (!steeringSnapshotSchema.safeParse(previous).success || validateSteeringSnapshot(previous).length)
    return { ok: false, issues: [{ code: "steering-change-snapshot-invalid", subject: "previous" }] };
  if (!steeringSnapshotSchema.safeParse(current).success || validateSteeringSnapshot(current).length)
    return { ok: false, issues: [{ code: "steering-change-snapshot-invalid", subject: "current" }] };
  if (previous.semantic.project !== current.semantic.project)
    return { ok: false, issues: [{ code: "steering-change-project-mismatch", subject: current.semantic.project }] };
  const candidate = {
    schema: STEERING_CHANGE_SET_SCHEMA,
    comparison: "complete-resolved-steering/v1" as const,
    snapshot_contract: STEERING_SNAPSHOT_SCHEMA,
    project: previous.semantic.project,
    previous: { snapshot: steeringSnapshotReference(previous), policy: previous.semantic.resolver.policy },
    current: { snapshot: steeringSnapshotReference(current), policy: current.semantic.resolver.policy },
    changes: deriveChanges(previous, current),
  };
  const parsed = steeringChangeSetSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: [{ code: "steering-change-comparison-incomplete",
    subject: parsed.error.issues[0]?.message }] };
  return { ok: true, value: freezeResolution(JSON.parse(new TextDecoder().decode(canonicalBytes(parsed.data))) as SteeringChangeSet) };
}

export function validateSteeringChangeSet(value: unknown): readonly SteeringChangeIssue[] {
  const parsed = steeringChangeSetSchema.safeParse(value);
  return parsed.success ? [] : [{ code: "steering-change-input-invalid",
    subject: parsed.error.issues[0]?.path.map(String).join(".") || parsed.error.issues[0]?.message }];
}

export const steeringStalenessReasonCodes = [
  "steering-dependency-resource-changed",
  "steering-dependency-rule-changed",
  "steering-dependency-rule-removed",
  "steering-dependency-authority-changed",
  "steering-dependency-scope-changed",
  "steering-dependency-inclusion-changed",
  "steering-dependency-enforcement-changed",
  "steering-dependency-provenance-changed",
  "steering-dependency-required-input-missing",
  "steering-dependency-resolution-policy-changed",
  "steering-dependency-unrelated-change",
  "steering-dependency-equivalent",
] as const;
export type SteeringStalenessReasonCode = typeof steeringStalenessReasonCodes[number];
export interface SteeringStalenessReason {
  readonly code: SteeringStalenessReasonCode;
  readonly resource?: SteeringResourceId;
  readonly semantic_key?: SteeringSemanticKey;
  readonly detail?: string;
}
export interface SteeringStalenessResult {
  readonly status: "still-applicable" | "stale" | "requires-reanalysis" | "invalid-input";
  readonly reasons: readonly SteeringStalenessReason[];
  readonly comparison?: Readonly<{ previous: SteeringSnapshotReference; current: SteeringSnapshotReference }>;
}
const stableReasons = (reasons: readonly SteeringStalenessReason[]): SteeringStalenessReason[] =>
  [...new Map(reasons.map((reason) => [canonical(reason), reason])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
const finishStaleness = (value: SteeringStalenessResult): SteeringStalenessResult =>
  freezeResolution(JSON.parse(new TextDecoder().decode(canonicalBytes(value))) as SteeringStalenessResult);
const invalidStaleness = (detail: string): SteeringStalenessResult => finishStaleness({
  status: "invalid-input",
  reasons: [{ code: "steering-dependency-required-input-missing", detail }],
});

function stateScopes(change: SteeringChange) {
  return [...change.previous.resources, ...change.current.resources].map((resource) => resource.resolved_scope).concat(
    [...change.previous.effective_rules, ...change.current.effective_rules].flatMap((rule) => rule.regions.map((region) => region.scope)));
}
function relevantChange(change: SteeringChange, dependency: SteeringDependency): boolean {
  const relevance = dependency.relevance?.scope;
  return relevance === undefined || change.kind === "resolver-policy-changed" ||
    stateScopes(change).some((scope) => !steeringScopesDisjoint(scope, relevance));
}
const stateHasBinding = (change: SteeringChange, binding: SteeringEnforcementBindingValue, side: "previous" | "current"): boolean => {
  const state = change[side];
  return state.resources.some((resource) => resource.default_enforcement.some((candidate) => exact(candidate, binding))) ||
    state.effective_rules.some((rule) => rule.enforcement.some((candidate) => exact(candidate, binding)));
};
function evaluateDeclared(dependency: Extract<SteeringDependency["dependency"], { mode: "declared" }>,
  envelope: SteeringDependency, changes: readonly SteeringChange[]): { reasons: SteeringStalenessReason[]; stale: boolean; reanalysis: boolean } {
  const reasons: SteeringStalenessReason[] = [];
  let stale = false, reanalysis = false;
  const add = (code: SteeringStalenessReasonCode, change: SteeringChange, detail?: string): void => {
    reasons.push({ code, ...(change.resource ? { resource: change.resource } : {}),
      ...(change.semantic_key ? { semantic_key: change.semantic_key } : {}), ...(detail ? { detail } : {}) });
  };
  for (const change of changes) {
    if (!relevantChange(change, envelope)) continue;
    if (change.kind === "resolver-policy-changed") {
      add("steering-dependency-resolution-policy-changed", change,
        `${change.previous_policy ?? "unknown"}->${change.current_policy ?? "unknown"}`);
      reanalysis = true; continue;
    }
    if (change.kind === "resolution-input-changed" && change.dimension === "action") {
      add("steering-dependency-scope-changed", change, "resolution-action");
      reanalysis = true; continue;
    }
    const resourceObserved = dependency.resources.some((reference) => change.resource === reference.id &&
      change.previous.resources.some((resource) => exact(resource.identity, reference)));
    const ruleObserved = dependency.rules.some((reference) =>
      change.previous.effective_rules.some((rule) => rule.contributors.some((contributor) => exact(contributor, reference))) ||
      change.previous.resources.some((resource) => exact(resource.identity, reference.resource)));
    const keyObserved = change.semantic_key !== undefined && dependency.semantic_keys.includes(change.semantic_key);
    const bindingObserved = dependency.enforcement.some((binding) => stateHasBinding(change, binding, "previous") || stateHasBinding(change, binding, "current"));
    if (!resourceObserved && !ruleObserved && !keyObserved && !bindingObserved) continue;

    if (resourceObserved && ["resource-removed", "resource-revision-changed"].includes(change.kind)) {
      add("steering-dependency-resource-changed", change); stale = true; continue;
    }
    if (ruleObserved && change.kind === "resource-removed") {
      add("steering-dependency-rule-removed", change); stale = true; continue;
    }
    if (ruleObserved && change.kind === "resource-revision-changed") {
      const reference = dependency.rules.find((candidate) => change.previous.resources.some((resource) => exact(resource.identity, candidate.resource)));
      const survives = reference !== undefined && changes.some((observation) => observation.current.effective_rules.some((rule) =>
        rule.contributors.some((contributor) => contributor.resource.id === reference.resource.id &&
          contributor.rule === reference.rule)));
      add(survives ? "steering-dependency-rule-changed" : "steering-dependency-rule-removed", change);
      stale = true; continue;
    }
    if ((ruleObserved || keyObserved) && change.kind === "semantic-rule-removed") {
      add("steering-dependency-rule-removed", change); stale = true; continue;
    }
    if ((ruleObserved || keyObserved) && ["semantic-rule-added", "semantic-value-changed"].includes(change.kind)) {
      add("steering-dependency-rule-changed", change); stale = true; continue;
    }
    if ((resourceObserved || ruleObserved || keyObserved) && change.kind === "authority-changed") {
      add("steering-dependency-authority-changed", change); reanalysis = true; continue;
    }
    if ((resourceObserved || ruleObserved || keyObserved) && change.kind === "scope-changed") {
      add("steering-dependency-scope-changed", change); reanalysis = true; continue;
    }
    if (resourceObserved && change.kind === "inclusion-changed") {
      add("steering-dependency-inclusion-changed", change); reanalysis = true; continue;
    }
    if ((resourceObserved || ruleObserved || keyObserved || bindingObserved) && change.kind === "enforcement-changed") {
      add("steering-dependency-enforcement-changed", change);
      const weakened = dependency.enforcement.some((binding) => isRequiredEnforcementBinding(binding) &&
        stateHasBinding(change, binding, "previous") && !stateHasBinding(change, binding, "current"));
      if (weakened) stale = true; else reanalysis = true;
      continue;
    }
    // A semantic-key declaration intentionally depends on the effective semantic
    // result, not on every equivalent contributor. Exact rule/resource modes above
    // still observe their own source provenance.
    if ((resourceObserved || ruleObserved) && change.kind === "provenance-changed") {
      add("steering-dependency-provenance-changed", change); reanalysis = true;
    }
  }
  return { reasons, stale, reanalysis };
}

/**
 * Pure causal applicability. It consumes exact immutable observations and never
 * discovers files, selects current Steering, reruns resolution, or mutates
 * planning lineage. Callers may use stale results as seeds for existing lineage
 * propagation.
 */
export function evaluateSteeringStaleness(
  dependencyValue: SteeringDependency | unknown,
  previousValue: SteeringSnapshot | unknown,
  currentOrChanges?: SteeringSnapshot | SteeringChangeSet | unknown,
): SteeringStalenessResult {
  const dependencyParsed = steeringDependencySchema.safeParse(dependencyValue);
  const previousParsed = steeringSnapshotSchema.safeParse(previousValue);
  if (!dependencyParsed.success) return invalidStaleness("dependency");
  if (!previousParsed.success || validateSteeringSnapshot(previousParsed.data).length) return invalidStaleness("previous-snapshot");
  const dependency = dependencyParsed.data as SteeringDependency, previous = previousParsed.data as SteeringSnapshot;
  if (validateSteeringDependency(dependency, previous).length) return invalidStaleness("dependency-observation");
  if (currentOrChanges === undefined) return invalidStaleness("comparison");

  let changeSet: SteeringChangeSet;
  const currentSnapshot = steeringSnapshotSchema.safeParse(currentOrChanges);
  if (currentSnapshot.success) {
    const compared = compareSteeringSnapshots(previous, currentSnapshot.data as SteeringSnapshot);
    if (!compared.ok) return invalidStaleness("current-snapshot");
    changeSet = compared.value;
  } else {
    const parsed = steeringChangeSetSchema.safeParse(currentOrChanges);
    if (!parsed.success) return invalidStaleness("change-set");
    changeSet = parsed.data as SteeringChangeSet;
  }
  if (!exact(changeSet.previous.snapshot, steeringSnapshotReference(previous)) || changeSet.project !== previous.semantic.project)
    return invalidStaleness("comparison-origin");
  const comparison = { previous: changeSet.previous.snapshot, current: changeSet.current.snapshot };
  if (changeSet.previous.policy !== previous.semantic.resolver.policy)
    return invalidStaleness("comparison-policy");
  if (exact(changeSet.previous.snapshot, changeSet.current.snapshot)) return finishStaleness({
    status: "still-applicable", reasons: [{ code: "steering-dependency-equivalent" }], comparison,
  });

  if (dependency.dependency.mode === "whole-snapshot") {
    const policy = changeSet.changes.find((change) => change.kind === "resolver-policy-changed");
    if (policy) return finishStaleness({ status: "requires-reanalysis", reasons: [{
      code: "steering-dependency-resolution-policy-changed",
      detail: `${policy.previous_policy ?? "unknown"}->${policy.current_policy ?? "unknown"}`,
    }], comparison });
    const substantive = changeSet.changes.filter((change) => change.kind !== "provenance-changed");
    if (!changeSet.changes.length) return invalidStaleness("empty-non-equivalent-comparison");
    const hard = substantive.some((change) => ["resource-removed", "resource-revision-changed", "semantic-rule-removed", "semantic-value-changed"].includes(change.kind));
    return finishStaleness({
      status: hard ? "stale" : "requires-reanalysis",
      reasons: stableReasons(changeSet.changes.map((change) => ({
        code: change.kind.startsWith("resource-") ? "steering-dependency-resource-changed" :
          change.kind === "authority-changed" ? "steering-dependency-authority-changed" :
          change.kind === "scope-changed" ? "steering-dependency-scope-changed" :
          change.kind === "inclusion-changed" ? "steering-dependency-inclusion-changed" :
          change.kind === "enforcement-changed" || change.kind === "compatibility-observation-changed" ?
            "steering-dependency-enforcement-changed" :
          change.kind === "provenance-changed" || change.kind === "resolution-decision-changed" ?
            "steering-dependency-provenance-changed" :
          change.kind === "resolution-input-changed" && change.dimension === "action" ?
            "steering-dependency-scope-changed" :
          change.kind === "resolution-input-changed" ? "steering-dependency-inclusion-changed" :
          change.kind === "semantic-rule-removed" ? "steering-dependency-rule-removed" : "steering-dependency-rule-changed",
        ...(change.resource ? { resource: change.resource } : {}),
        ...(change.semantic_key ? { semantic_key: change.semantic_key } : {}),
      }))),
      comparison,
    });
  }

  const evaluated = evaluateDeclared(dependency.dependency, dependency, changeSet.changes);
  if (evaluated.stale) return finishStaleness({ status: "stale", reasons: stableReasons(evaluated.reasons), comparison });
  if (evaluated.reanalysis) return finishStaleness({ status: "requires-reanalysis", reasons: stableReasons(evaluated.reasons), comparison });
  return finishStaleness({
    status: "still-applicable",
    reasons: [{ code: changeSet.changes.length ? "steering-dependency-unrelated-change" : "steering-dependency-equivalent" }],
    comparison,
  });
}
