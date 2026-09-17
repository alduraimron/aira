import { z } from "zod";
import { canonicalBytes, hashCanonical } from "../canonical-json";
import {
  blobReferenceSchema,
  canonical,
  compareText,
  contentHashSchema,
  createdMetadataSchema,
  exact,
  timestampSchema,
  type ContentHash,
  type DeepReadonly,
} from "../spec/domain/primitives";
import { enforcementBindingIdentity, isRequiredEnforcementBinding } from "./authority";
import { orderSteeringRevision } from "./hierarchy";
import {
  steeringRevisionReferenceSchema,
  steeringSnapshotIdSchema,
  type SteeringRevisionReference,
  type SteeringSnapshotId,
} from "./ids";
import {
  STEERING_RESOLVER_POLICY,
  STEERING_RESOLVER_SCHEMA,
  distinct,
  freezeResolution,
  sorted,
  stableResolutionIssues,
  steeringApplicableRuleSchema,
  steeringEffectiveRuleSchema,
  steeringIncludedResourceSchema,
  steeringOmissionSchema,
  steeringOverrideDecisionSchema,
  steeringResolutionInputsSchema,
  steeringResolutionIssueSchema,
  steeringResolvedBindingSchema,
  steeringResolvedResultSchema,
  steeringRuleReferenceSchema,
  type SteeringApplicableRule,
  type SteeringEffectiveRule,
  type SteeringIncludedResource,
  type SteeringResolutionResult,
  type SteeringResolvedBinding,
  type SteeringResolvedResult,
  type SteeringRuleReference,
} from "./resolution-contract";
import { steeringProjectNamespaceSchema, steeringResourceRevisionSchema } from "./schema";

export const STEERING_SNAPSHOT_SCHEMA = "aira.dev/steering-snapshot/v1" as const;
export const STEERING_SNAPSHOT_ENCODING = "aira.dev/canonical-json/v1" as const;
export const STEERING_SNAPSHOT_MEDIA_TYPE = "application/vnd.aira.steering-snapshot+json" as const;

const { created: _resourceCreatedSchema, ...steeringSemanticResourceRevisionShape } = steeringResourceRevisionSchema.shape;
const steeringSemanticResourceRevisionSchema = z.strictObject(steeringSemanticResourceRevisionShape);
export const steeringSnapshotResourceSchema = steeringIncludedResourceSchema.extend({
  revision: steeringSemanticResourceRevisionSchema,
});
export const steeringSnapshotSemanticSchema = z.strictObject({
  contract: z.literal(STEERING_SNAPSHOT_SCHEMA),
  project: steeringProjectNamespaceSchema,
  resolver: z.strictObject({
    contract: z.literal(STEERING_RESOLVER_SCHEMA),
    policy: z.literal(STEERING_RESOLVER_POLICY),
  }),
  selectors: z.strictObject({
    action: steeringResolutionInputsSchema.shape.action,
    resources: steeringResolutionInputsSchema.shape.selections,
    manual: steeringResolutionInputsSchema.shape.manual,
  }),
  compatibility: z.strictObject({
    supported_contracts: steeringResolutionInputsSchema.shape.supported_contracts,
    available_enforcement: steeringResolutionInputsSchema.shape.available_enforcement,
  }),
  hierarchy_order: z.array(steeringRevisionReferenceSchema),
  resources: z.array(steeringSnapshotResourceSchema),
  applicable_rules: z.array(steeringApplicableRuleSchema),
  effective_rules: z.array(steeringEffectiveRuleSchema),
  enforcement: z.array(steeringResolvedBindingSchema),
  decisions: z.strictObject({
    overrides: z.array(steeringOverrideDecisionSchema),
    shadowed_rules: z.array(z.strictObject({
      target: steeringRuleReferenceSchema,
      by: steeringRuleReferenceSchema,
      scope: steeringEffectiveRuleSchema.shape.regions.element.shape.scope,
      coverage: z.enum(["full", "partial"]),
    })),
    omissions: z.array(steeringOmissionSchema),
    diagnostics: z.array(steeringResolutionIssueSchema),
  }),
});
export const steeringSnapshotAuditSchema = z.strictObject({
  constructed_at: timestampSchema.optional(),
  resource_creation: z.array(z.strictObject({
    resource: steeringRevisionReferenceSchema,
    created: createdMetadataSchema,
  })),
});
export const steeringSnapshotSchema = z.strictObject({
  schema: z.literal(STEERING_SNAPSHOT_SCHEMA),
  id: steeringSnapshotIdSchema,
  content: blobReferenceSchema.refine((content) => content.media_type === STEERING_SNAPSHOT_MEDIA_TYPE,
    "invalid-steering-snapshot-media-type"),
  content_encoding: z.literal(STEERING_SNAPSHOT_ENCODING),
  semantic: steeringSnapshotSemanticSchema,
  audit: steeringSnapshotAuditSchema,
});
export const steeringSnapshotReferenceSchema = z.strictObject({
  id: steeringSnapshotIdSchema,
  hash: contentHashSchema,
}).refine((reference) => reference.id === steeringSnapshotIdFromHash(reference.hash),
  "steering-snapshot-reference-hash-mismatch");

export type SteeringSnapshotSemantic = DeepReadonly<z.infer<typeof steeringSnapshotSemanticSchema>>;
export type SteeringSnapshot = DeepReadonly<z.infer<typeof steeringSnapshotSchema>>;
export type SteeringSnapshotReference = DeepReadonly<z.infer<typeof steeringSnapshotReferenceSchema>>;
export type SteeringSnapshotAudit = DeepReadonly<z.infer<typeof steeringSnapshotAuditSchema>>;

export const steeringSnapshotIssueCodes = [
  "steering-snapshot-resolution-required",
  "steering-snapshot-resolution-conflicted",
  "steering-snapshot-resolution-invalid",
  "steering-snapshot-resolution-incomplete",
  "steering-snapshot-policy-unsupported",
  "steering-snapshot-revision-missing",
  "steering-snapshot-hash-missing",
  "steering-snapshot-resource-unresolved",
  "steering-snapshot-structure-invalid",
  "steering-snapshot-project-mismatch",
  "steering-snapshot-resource-hash-mismatch",
  "steering-snapshot-provenance-inconsistent",
  "steering-snapshot-contributor-missing",
  "steering-snapshot-override-reference-missing",
  "steering-snapshot-enforcement-missing",
  "steering-snapshot-selector-provenance-inconsistent",
  "steering-snapshot-effective-rule-duplicate",
  "steering-snapshot-canonical-order-invalid",
  "steering-snapshot-content-hash-mismatch",
  "steering-snapshot-identity-mismatch",
] as const;
export type SteeringSnapshotIssueCode = typeof steeringSnapshotIssueCodes[number];
export interface SteeringSnapshotIssue {
  readonly code: SteeringSnapshotIssueCode;
  readonly subject?: string;
  readonly resource?: SteeringRevisionReference;
  readonly rule?: SteeringRuleReference;
  readonly related?: readonly string[];
}
export type SteeringSnapshotBuildResult =
  | { readonly ok: true; readonly value: SteeringSnapshot }
  | { readonly ok: false; readonly issues: readonly SteeringSnapshotIssue[] };

const stableSnapshotIssues = (issues: readonly SteeringSnapshotIssue[]): SteeringSnapshotIssue[] =>
  [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
const revisionKey = (reference: SteeringRevisionReference): string => canonical(reference);
const ruleKey = (reference: SteeringRuleReference): string => `${revisionKey(reference.resource)}#${reference.rule}`;
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The full lowercase SHA-256 digest is the snapshot token. No truncation or alias lookup occurs. */
export function steeringSnapshotIdFromHash(hash: ContentHash): SteeringSnapshotId {
  return steeringSnapshotIdSchema.parse(`steering_snapshot_${hash.slice("sha256:".length)}`);
}
export const steeringSnapshotReference = (snapshot: SteeringSnapshot): SteeringSnapshotReference => ({
  id: snapshot.id,
  hash: snapshot.content.hash,
});
export const steeringSnapshotSemanticBytes = (snapshot: Pick<SteeringSnapshot, "semantic">): Uint8Array =>
  canonicalBytes(snapshot.semantic);

function initialResolutionIssues(value: unknown): SteeringSnapshotIssue[] {
  const object = asObject(value);
  if (!object) return [{ code: "steering-snapshot-resolution-required" }];
  if (object.status === "conflicted") return [{ code: "steering-snapshot-resolution-conflicted" }];
  if (object.status === "invalid-input") return [{ code: "steering-snapshot-resolution-invalid" }];
  if (object.status !== "resolved") return [{ code: "steering-snapshot-resolution-required" }];
  const inputs = asObject(object.inputs);
  if (object.schema !== STEERING_RESOLVER_SCHEMA || object.policy !== STEERING_RESOLVER_POLICY ||
    (inputs !== undefined && (inputs.schema !== STEERING_RESOLVER_SCHEMA || inputs.policy !== STEERING_RESOLVER_POLICY)))
    return [{ code: "steering-snapshot-policy-unsupported",
      subject: String(object.policy ?? inputs?.policy ?? object.schema ?? inputs?.schema ?? "missing") }];
  const issues: SteeringSnapshotIssue[] = [];
  for (const entry of Array.isArray(object.included_resources) ? object.included_resources : []) {
    const resource = asObject(entry), revision = asObject(resource?.revision), identity = asObject(revision?.identity), content = asObject(revision?.content);
    if (identity?.revision === undefined) issues.push({ code: "steering-snapshot-revision-missing", subject: String(identity?.id ?? "resource") });
    if (identity?.hash === undefined || content?.hash === undefined)
      issues.push({ code: "steering-snapshot-hash-missing", subject: String(identity?.id ?? "resource") });
  }
  for (const field of ["inputs", "hierarchy_order", "included_resources", "applicable_rules", "omissions", "overrides", "shadowed_rules", "effective_rules", "enforcement"])
    if (!(field in object)) issues.push({ code: "steering-snapshot-resolution-incomplete", subject: field });
  return stableSnapshotIssues(issues);
}

const sameSet = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  exact(distinct(left), distinct(right));
const exactApplicable = (left: SteeringApplicableRule, right: SteeringApplicableRule): boolean => exact(left, right);
const requiredBindingPresent = (binding: SteeringResolvedBinding["binding"], result: SteeringResolvedResult): boolean =>
  !isRequiredEnforcementBinding(binding) || result.inputs.available_enforcement.some((candidate) => exact(candidate, binding));

/**
 * Checks internal consistency of a detached successful decision record. This is
 * structural replay of references and decisions only. It never calls the 05C-2
 * resolver and never consults a current catalog.
 */
function resolutionConsistencyIssues(result: SteeringResolvedResult): SteeringSnapshotIssue[] {
  const issues: SteeringSnapshotIssue[] = [];
  const issue = (code: SteeringSnapshotIssueCode, subject?: string, resource?: SteeringRevisionReference,
    rule?: SteeringRuleReference): void => {
    issues.push({ code, ...(subject ? { subject } : {}),
      ...(resource ? { resource } : {}), ...(rule ? { rule } : {}) });
  };
  if (result.schema !== result.inputs.schema || result.policy !== result.inputs.policy)
    issue("steering-snapshot-policy-unsupported", result.policy);
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    issue("steering-snapshot-resolution-incomplete", "successful-result-has-error-diagnostic");
  if (new Set(result.hierarchy_order.map(revisionKey)).size !== result.hierarchy_order.length)
    issue("steering-snapshot-structure-invalid", "duplicate-hierarchy-resource");

  const resources = result.included_resources;
  for (const entry of resources) {
    const reference = entry.revision.identity;
    if (reference.hash !== entry.revision.content.hash)
      issue("steering-snapshot-resource-hash-mismatch", undefined, reference);
    if (entry.tier !== entry.revision.layer || entry.order !== result.hierarchy_order.findIndex((candidate) => exact(candidate, reference)))
      issue("steering-snapshot-provenance-inconsistent", "resource-tier-or-order", reference);
    if (entry.reasons.length === 0 || entry.scope_evaluation.outcome !== "match" || entry.inclusion_evaluation.outcome !== "match" ||
      !exact(entry.scope_evaluation.declaration, entry.revision.scope) ||
      !exact(entry.inclusion_evaluation.declaration, entry.revision.inclusion.selector))
      issue("steering-snapshot-selector-provenance-inconsistent", "resource-evaluation", reference);
    if (entry.revision.provenance.kind === "project" && entry.revision.provenance.project !== result.inputs.project)
      issue("steering-snapshot-project-mismatch", undefined, reference);
    if (entry.revision.compatibility.resolver !== result.schema ||
      entry.revision.compatibility.required_schemas.some((contract) => !result.inputs.supported_contracts.includes(contract)))
      issue("steering-snapshot-provenance-inconsistent", "resource-compatibility", reference);
    for (const reason of entry.reasons) {
      const valid = reason.evaluation.outcome === "match" && (
        reason.kind === "selection" ? reason.from === undefined && result.inputs.selections.some((selection) =>
          exact(selection.resource, reference) && exact(selection.inclusion.selector, reason.evaluation.declaration)) :
        reason.kind === "manual" ? reason.from === undefined && reason.evaluation.declaration.kind === "manual" &&
          result.inputs.manual.some((selection) => exact(selection.resource, reference)) :
        reason.from !== undefined && reason.evaluation.declaration.kind === "always" && resources.some((source) =>
          exact(source.revision.identity, reason.from) && source.revision.composition.parents.some((parent) => exact(parent, reference)))
      );
      if (!valid) issue("steering-snapshot-selector-provenance-inconsistent", `inclusion-reason:${reason.kind}`, reference);
    }
  }
  if (resources.some((entry, index) => index > 0 &&
    (entry.order < resources[index - 1]!.order || (entry.order === resources[index - 1]!.order &&
      compareText(revisionKey(resources[index - 1]!.revision.identity), revisionKey(entry.revision.identity)) >= 0))))
    issue("steering-snapshot-canonical-order-invalid", "resources");
  if (new Set(resources.map((entry) => entry.revision.identity.id)).size !== resources.length)
    issue("steering-snapshot-resource-unresolved", "multiple-active-resource-revisions");

  const applicable = result.applicable_rules;
  for (const rule of applicable) {
    const reference = { resource: rule.resource, rule: rule.rule } as SteeringRuleReference;
    const owner = resources.find((entry) => exact(entry.revision.identity, rule.resource));
    const declaration = owner?.revision.rules.find((candidate) => candidate.id === rule.rule);
    if (!owner || !declaration || declaration.status !== "active" || !exact(declaration, rule.declaration) ||
      !exact(rule.semantics, declaration.semantics) || rule.authority !== declaration.authority ||
      rule.override_policy !== declaration.override_policy || !exact(rule.enforcement, declaration.enforcement) ||
      rule.tier !== owner.tier || rule.resource_order !== owner.order)
      issue("steering-snapshot-contributor-missing", "applicable-rule-source", rule.resource, reference);
    const declaredScope = declaration?.scope ?? owner?.revision.scope;
    const declaredInclusion = declaration?.inclusion?.selector ?? { kind: "always" };
    if (rule.scope_evaluation.outcome !== "match" || rule.inclusion_evaluation.outcome !== "match" ||
      !exact(rule.scope_evaluation.declaration, declaredScope) || !exact(rule.inclusion_evaluation.declaration, declaredInclusion))
      issue("steering-snapshot-selector-provenance-inconsistent", "rule-evaluation", rule.resource, reference);
  }

  const groupKeys = result.effective_rules.map((rule) => canonical({ semantics: rule.semantics, authority: rule.authority }));
  if (new Set(groupKeys).size !== groupKeys.length)
    issue("steering-snapshot-effective-rule-duplicate", "semantic-result");
  for (const effective of result.effective_rules) {
    for (const contributor of effective.contributors) {
      const reference = { resource: contributor.resource, rule: contributor.rule } as SteeringRuleReference;
      if (!applicable.some((candidate) => exactApplicable(candidate, contributor)) ||
        !exact(contributor.semantics, effective.semantics) || contributor.authority !== effective.authority)
        issue("steering-snapshot-contributor-missing", "effective-contributor", contributor.resource, reference);
      if (!effective.regions.some((region) => ruleKey(region.source) === ruleKey(reference)))
        issue("steering-snapshot-contributor-missing", "effective-region", contributor.resource, reference);
    }
    for (const region of effective.regions) if (!effective.contributors.some((contributor) =>
      ruleKey({ resource: contributor.resource, rule: contributor.rule }) === ruleKey(region.source)))
      issue("steering-snapshot-contributor-missing", "region-source", region.source.resource, region.source);
    const expectedBindings = distinct(effective.contributors.flatMap((contributor) => contributor.enforcement));
    if (!sameSet(effective.enforcement, expectedBindings))
      issue("steering-snapshot-enforcement-missing", `effective:${effective.semantics.key}`);
    if (effective.authority === "enforceable" && !effective.enforcement.some(isRequiredEnforcementBinding))
      issue("steering-snapshot-enforcement-missing", `enforceable:${effective.semantics.key}`);
  }

  for (const decision of result.overrides) {
    const source = applicable.find((rule) => ruleKey({ resource: rule.resource, rule: rule.rule }) === ruleKey(decision.source));
    const target = applicable.find((rule) => ruleKey({ resource: rule.resource, rule: rule.rule }) === ruleKey(decision.target));
    const owner = resources.find((entry) => exact(entry.revision.identity, decision.source.resource));
    if (!source || !target || !owner || !owner.revision.composition.overrides.some((declaration) =>
      exact(declaration, decision.declaration)) || !exact(decision.declaration.target.resource, decision.target.resource) ||
      (decision.declaration.target.rule !== undefined && decision.declaration.target.rule !== decision.target.rule))
      issue("steering-snapshot-override-reference-missing", undefined, decision.source.resource, decision.source);
  }
  const expectedShadowed = result.overrides.filter((decision) => decision.disposition === "supersede").map((decision) => ({
    target: decision.target,
    by: decision.source,
    scope: decision.scope,
    coverage: decision.relation === "equal" ? "full" as const : "partial" as const,
  }));
  if (!sameSet(result.shadowed_rules, expectedShadowed))
    issue("steering-snapshot-override-reference-missing", "shadowed-decision");

  const expectedBindings = new Map<string, { binding: SteeringResolvedBinding["binding"]; sources: SteeringResolvedBinding["sources"][number][] }>();
  const add = (binding: SteeringResolvedBinding["binding"], source: SteeringResolvedBinding["sources"][number]): void => {
    const key = canonical(binding), current = expectedBindings.get(key) ?? { binding, sources: [] };
    current.sources.push(source); expectedBindings.set(key, current);
  };
  for (const rule of applicable) for (const binding of rule.enforcement)
    add(binding, { resource: rule.resource, rule: rule.rule, scope: rule.scope });
  for (const entry of resources) for (const binding of entry.revision.default_enforcement)
    add(binding, { resource: entry.revision.identity, scope: entry.scope });
  const expectedEnforcement = [...expectedBindings.values()].map((entry) => ({
    binding: entry.binding,
    sources: sorted(entry.sources),
  })).sort((left, right) => compareText(enforcementBindingIdentity(left.binding), enforcementBindingIdentity(right.binding)) ||
    compareText(canonical(left.binding), canonical(right.binding)));
  if (!exact(result.enforcement, expectedEnforcement)) issue("steering-snapshot-enforcement-missing", "aggregate");
  for (const binding of result.enforcement) {
    if (!requiredBindingPresent(binding.binding, result))
      issue("steering-snapshot-enforcement-missing", enforcementBindingIdentity(binding.binding));
    if (binding.binding.kind === "extension" && binding.binding.use === "required" &&
      !result.inputs.supported_contracts.includes(binding.binding.contract))
      issue("steering-snapshot-enforcement-missing", binding.binding.contract);
  }
  for (const omission of result.omissions) if (omission.availability === "required" && omission.reason === "unavailable")
    issue("steering-snapshot-resource-unresolved", "required-omission", omission.resource);
  return stableSnapshotIssues(issues);
}

function compareApplicable(left: SteeringApplicableRule, right: SteeringApplicableRule): number {
  return left.resource_order - right.resource_order || compareText(left.rule, right.rule) ||
    compareText(revisionKey(left.resource), revisionKey(right.resource)) || compareText(canonical(left), canonical(right));
}
function normalizeEffective(rule: SteeringEffectiveRule): SteeringEffectiveRule {
  return {
    ...rule,
    contributors: [...rule.contributors].sort(compareApplicable),
    regions: [...rule.regions].map((region) => ({ ...region, excluded_scopes: sorted(region.excluded_scopes) }))
      .sort((left, right) => compareText(ruleKey(left.source), ruleKey(right.source)) || compareText(canonical(left), canonical(right))),
    enforcement: sorted(rule.enforcement),
  };
}
function semanticFromResolution(result: SteeringResolvedResult): unknown {
  const resources = [...result.included_resources].map((entry) => {
    const ordered = orderSteeringRevision(entry.revision);
    const { created: _created, ...revision } = ordered;
    return { ...entry, revision, reasons: sorted(entry.reasons) };
  }).sort((left, right) => left.order - right.order || compareText(revisionKey(left.revision.identity), revisionKey(right.revision.identity)));
  const applicable = [...result.applicable_rules].sort(compareApplicable);
  const effective = result.effective_rules.map(normalizeEffective).sort((left, right) =>
    left.contributors[0]!.resource_order - right.contributors[0]!.resource_order ||
    compareText(left.semantics.key, right.semantics.key) || compareText(left.semantics.effect, right.semantics.effect) ||
    compareText(canonical(left.semantics.value), canonical(right.semantics.value)) || compareText(left.authority, right.authority));
  const enforcement = result.enforcement.map((entry) => ({ ...entry, sources: sorted(entry.sources) }))
    .sort((left, right) => compareText(enforcementBindingIdentity(left.binding), enforcementBindingIdentity(right.binding)) ||
      compareText(canonical(left.binding), canonical(right.binding)));
  return {
    contract: STEERING_SNAPSHOT_SCHEMA,
    project: result.inputs.project,
    resolver: { contract: result.schema, policy: result.policy },
    selectors: {
      action: result.inputs.action,
      resources: sorted(result.inputs.selections),
      manual: sorted(result.inputs.manual),
    },
    compatibility: {
      supported_contracts: sorted(result.inputs.supported_contracts),
      available_enforcement: sorted(result.inputs.available_enforcement),
    },
    hierarchy_order: [...result.hierarchy_order],
    resources,
    applicable_rules: applicable,
    effective_rules: effective,
    enforcement,
    decisions: {
      overrides: sorted(result.overrides),
      shadowed_rules: sorted(result.shadowed_rules),
      omissions: sorted(result.omissions),
      diagnostics: stableResolutionIssues(result.diagnostics),
    },
  };
}

function resolutionFromSnapshot(snapshot: z.infer<typeof steeringSnapshotSchema>): SteeringResolvedResult | undefined {
  const creation = new Map(snapshot.audit.resource_creation.map((entry) => [revisionKey(entry.resource), entry.created]));
  if (creation.size !== snapshot.semantic.resources.length) return undefined;
  const resources: SteeringIncludedResource[] = [];
  for (const entry of snapshot.semantic.resources) {
    const created = creation.get(revisionKey(entry.revision.identity));
    if (!created) return undefined;
    resources.push({ ...entry, revision: { ...entry.revision, created } } as SteeringIncludedResource);
  }
  return {
    schema: snapshot.semantic.resolver.contract,
    policy: snapshot.semantic.resolver.policy,
    status: "resolved",
    diagnostics: snapshot.semantic.decisions.diagnostics,
    inputs: {
      schema: snapshot.semantic.resolver.contract,
      policy: snapshot.semantic.resolver.policy,
      project: snapshot.semantic.project,
      action: snapshot.semantic.selectors.action,
      selections: snapshot.semantic.selectors.resources,
      manual: snapshot.semantic.selectors.manual,
      supported_contracts: snapshot.semantic.compatibility.supported_contracts,
      available_enforcement: snapshot.semantic.compatibility.available_enforcement,
    },
    hierarchy_order: snapshot.semantic.hierarchy_order,
    included_resources: resources,
    applicable_rules: snapshot.semantic.applicable_rules,
    omissions: snapshot.semantic.decisions.omissions,
    overrides: snapshot.semantic.decisions.overrides,
    shadowed_rules: snapshot.semantic.decisions.shadowed_rules,
    effective_rules: snapshot.semantic.effective_rules,
    enforcement: snapshot.semantic.enforcement,
  } as SteeringResolvedResult;
}

export function validateSteeringSnapshot(value: unknown): readonly SteeringSnapshotIssue[] {
  const parsed = steeringSnapshotSchema.safeParse(value);
  if (!parsed.success) return stableSnapshotIssues(parsed.error.issues.map((schemaIssue) => ({
    code: schemaIssue.path.includes("id") ? "steering-snapshot-identity-mismatch" :
      schemaIssue.path.includes("hash") ? "steering-snapshot-content-hash-mismatch" : "steering-snapshot-structure-invalid",
    ...(schemaIssue.path.length ? { subject: schemaIssue.path.map(String).join(".") } : {}),
  })));
  const snapshot = parsed.data;
  const issues: SteeringSnapshotIssue[] = [];
  const bytes = canonicalBytes(snapshot.semantic), hash = hashCanonical(snapshot.semantic);
  if (snapshot.content.hash !== hash || snapshot.content.bytes !== bytes.byteLength)
    issues.push({ code: "steering-snapshot-content-hash-mismatch", subject: snapshot.id });
  if (snapshot.id !== steeringSnapshotIdFromHash(hash))
    issues.push({ code: "steering-snapshot-identity-mismatch", subject: snapshot.id });
  const resourceAuditOrder = snapshot.audit.resource_creation.map((entry) => entry.resource);
  if (!exact(resourceAuditOrder, snapshot.semantic.resources.map((entry) => entry.revision.identity)))
    issues.push({ code: "steering-snapshot-canonical-order-invalid", subject: "audit.resource_creation" });
  const result = resolutionFromSnapshot(snapshot);
  if (!result) issues.push({ code: "steering-snapshot-provenance-inconsistent", subject: "resource-creation-attribution" });
  else {
    const decoded = steeringResolvedResultSchema.safeParse(result);
    if (!decoded.success) issues.push({ code: "steering-snapshot-structure-invalid", subject: "detached-resolution" });
    else {
      issues.push(...resolutionConsistencyIssues(decoded.data as SteeringResolvedResult));
      if (!exact(snapshot.semantic, semanticFromResolution(decoded.data as SteeringResolvedResult)))
        issues.push({ code: "steering-snapshot-canonical-order-invalid", subject: "semantic-payload" });
    }
  }
  return stableSnapshotIssues(issues);
}

/**
 * Freezes one exact successful 05C-2 result. No catalog lookup, current alias,
 * resolver replay, clock, storage port, or filesystem operation is involved.
 */
export function buildSteeringSnapshot(
  resolution: SteeringResolutionResult | unknown,
  audit: { readonly constructed_at?: string } = {},
): SteeringSnapshotBuildResult {
  const initial = initialResolutionIssues(resolution);
  if (initial.length) return { ok: false, issues: initial };
  const parsed = steeringResolvedResultSchema.safeParse(resolution);
  if (!parsed.success) return { ok: false, issues: [{ code: "steering-snapshot-structure-invalid",
    subject: parsed.error.issues[0]?.path.map(String).join(".") || "resolution" }] };
  const result = parsed.data as SteeringResolvedResult;
  const consistency = resolutionConsistencyIssues(result);
  if (consistency.length) return { ok: false, issues: consistency };
  if (audit.constructed_at !== undefined && !timestampSchema.safeParse(audit.constructed_at).success)
    return { ok: false, issues: [{ code: "steering-snapshot-structure-invalid", subject: "audit.constructed_at" }] };

  const semantic = steeringSnapshotSemanticSchema.parse(semanticFromResolution(result));
  const bytes = canonicalBytes(semantic), hash = hashCanonical(semantic);
  const resources = [...result.included_resources].sort((left, right) => left.order - right.order ||
    compareText(revisionKey(left.revision.identity), revisionKey(right.revision.identity)));
  const snapshot = steeringSnapshotSchema.parse({
    schema: STEERING_SNAPSHOT_SCHEMA,
    id: steeringSnapshotIdFromHash(hash),
    content: { hash, bytes: bytes.byteLength, media_type: STEERING_SNAPSHOT_MEDIA_TYPE },
    content_encoding: STEERING_SNAPSHOT_ENCODING,
    semantic,
    audit: {
      ...(audit.constructed_at === undefined ? {} : { constructed_at: audit.constructed_at }),
      resource_creation: resources.map((entry) => ({ resource: entry.revision.identity, created: entry.revision.created })),
    },
  });
  const validation = validateSteeringSnapshot(snapshot);
  if (validation.length) return { ok: false, issues: validation };
  // Canonical round-trip detaches every caller-owned nested object before freezing.
  return { ok: true, value: freezeResolution(JSON.parse(new TextDecoder().decode(canonicalBytes(snapshot))) as SteeringSnapshot) };
}
