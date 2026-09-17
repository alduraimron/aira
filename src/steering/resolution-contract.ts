import { z } from "zod";
import { exactPathSchema } from "../context/declarations";
import { operationIdSchema, specIdSchema, taskIdSchema } from "../spec/domain/ids";
import { canonical, channelSchema, compareText, humanActorSchema, type DeepReadonly } from "../spec/domain/primitives";
import {
  steeringInclusionSchema,
  steeringInclusionSelectorSchema,
  steeringPhaseSchema,
  steeringScopeSchema,
  steeringSpecKindSelectorSchema,
  steeringTaskKindSelectorSchema,
} from "./applicability";
import {
  steeringAuthoritySchema,
  steeringEnforcementBindingSchema,
  steeringOverridePolicySchema,
  versionedContractSchema,
} from "./authority";
import {
  steeringRevisionReferenceSchema,
  steeringRuleIdSchema,
  steeringSemanticKeySchema,
  type SteeringRevisionReference,
  type SteeringRuleId,
  type SteeringSemanticKey,
} from "./ids";
import {
  steeringLayerSchema,
  steeringOverrideSchema,
  steeringProjectNamespaceSchema,
  steeringResourceRevisionSchema,
  steeringRuleSchema,
  steeringRuleSemanticsSchema,
} from "./schema";
import type { SteeringEnforcementBinding, SteeringInclusionSelector, SteeringOverride, SteeringResourceRevision, SteeringRule, SteeringScope } from "./types";

export const STEERING_RESOLVER_SCHEMA = "aira.dev/steering-resolution/v1" as const;
export const STEERING_RESOLVER_POLICY = "aira.dev/steering-policy/conservative/v1" as const;
export const STEERING_RESOLVER_LIMITS = {
  nodes: 100_000, depth: 48, resources: 256, rules_per_resource: 256, total_rules: 1024,
  paths: 1024, path_length: 1024, path_segments: 128,
} as const;

const authorizationSchema = z.strictObject({
  project: steeringProjectNamespaceSchema, by: humanActorSchema,
  operation: operationIdSchema, channel: channelSchema.optional(),
});
export const steeringActionSchema = z.strictObject({
  phase: steeringPhaseSchema,
  spec: z.strictObject({ id: specIdSchema.optional(), selector: steeringSpecKindSelectorSchema }).optional(),
  task: z.strictObject({ id: taskIdSchema.optional(), selector: steeringTaskKindSelectorSchema }).optional(),
  paths: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("unknown") }),
    z.strictObject({ status: z.literal("known"), paths: z.array(exactPathSchema.max(STEERING_RESOLVER_LIMITS.path_length)
      .refine((path) => path.split("/").length <= STEERING_RESOLVER_LIMITS.path_segments)).max(STEERING_RESOLVER_LIMITS.paths) }),
  ]).optional(),
});
export const steeringResolutionInputsSchema = z.strictObject({
  schema: z.literal(STEERING_RESOLVER_SCHEMA), policy: z.literal(STEERING_RESOLVER_POLICY),
  project: steeringProjectNamespaceSchema, action: steeringActionSchema,
  // The registry/selection adapter supplies exact expectations, including unavailable revisions.
  selections: z.array(z.strictObject({ resource: steeringRevisionReferenceSchema, inclusion: steeringInclusionSchema })).max(256),
  manual: z.array(z.strictObject({
    resource: steeringRevisionReferenceSchema, rule: steeringRuleIdSchema.optional(),
    availability: z.enum(["required", "optional"]), authorization: authorizationSchema,
  })).max(256),
  supported_contracts: z.array(versionedContractSchema).max(256),
  // Caller-validated exact mechanism observations, NOT an assertion of runtime confinement.
  available_enforcement: z.array(steeringEnforcementBindingSchema).max(1024),
});
export type SteeringResolutionInputs = DeepReadonly<z.infer<typeof steeringResolutionInputsSchema>>;
export type SteeringAction = SteeringResolutionInputs["action"];
export type SteeringResolutionRequest = SteeringResolutionInputs & { readonly catalog: readonly SteeringResourceRevision[] };
export type SteeringRuleReference = { readonly resource: SteeringRevisionReference; readonly rule: SteeringRuleId };
export type SteeringRuleSubject = SteeringRuleReference & {
  readonly scope: SteeringScope; readonly authority: SteeringRule["authority"];
  readonly override_policy: SteeringRule["override_policy"]; readonly semantics: SteeringRule["semantics"];
  readonly enforcement: readonly SteeringEnforcementBinding[];
};

// Lowercase kebab-case follows the existing DomainIssue convention. These are public API codes.
export const steeringResolutionIssueCodes = [
  "steering-input-invalid", "steering-input-limit", "steering-policy-unsupported",
  "steering-duplicate-resource", "steering-duplicate-rule", "steering-duplicate-selection",
  "steering-parent-missing", "steering-parent-cycle", "steering-parent-duplicate", "steering-parent-invalid",
  "steering-source-invalid", "steering-project-mismatch", "steering-compatibility-invalid",
  "steering-scope-invalid", "steering-scope-widening", "steering-inclusion-widening",
  "steering-override-target-missing", "steering-override-not-allowed", "steering-override-ambiguous",
  "steering-sealed-rule-override", "steering-semantic-conflict", "steering-authority-conflict",
  "steering-enforcement-weakening", "steering-enforcement-conflict", "steering-enforcement-missing",
  "steering-required-resource-missing", "steering-manual-selection-missing", "steering-manual-unauthorized",
  "steering-inclusion-input-missing", "steering-optional-resource-missing", "steering-conflict-unresolved",
] as const;
export type SteeringResolutionIssueCode = typeof steeringResolutionIssueCodes[number];
export interface SteeringResolutionIssue {
  readonly code: SteeringResolutionIssueCode;
  readonly severity: "error" | "warning";
  readonly resource?: SteeringRevisionReference;
  readonly rule?: SteeringRuleId;
  readonly semantic_key?: SteeringSemanticKey;
  readonly related?: readonly SteeringRevisionReference[];
  readonly rules?: readonly SteeringRuleSubject[];
  /** Stable machine-readable reason, never an array index or a prose API. */
  readonly detail?: string;
  readonly override?: SteeringOverride;
}
export interface SteeringEvaluation {
  readonly declaration: SteeringScope | SteeringInclusionSelector;
  readonly outcome: "match" | "miss" | "error";
  readonly children: readonly SteeringEvaluation[];
  readonly matched_paths: readonly string[];
  readonly missing: readonly string[];
}
export interface SteeringIncludedResource {
  readonly revision: SteeringResourceRevision;
  readonly tier: SteeringResourceRevision["layer"];
  readonly order: number;
  readonly scope: SteeringScope;
  readonly reasons: readonly { readonly kind: "selection" | "manual" | "parent"; readonly from?: SteeringRevisionReference; readonly evaluation: SteeringEvaluation }[];
  readonly scope_evaluation: SteeringEvaluation;
  readonly inclusion_evaluation: SteeringEvaluation;
}
export interface SteeringApplicableRule extends SteeringRuleSubject {
  readonly declaration: SteeringRule;
  readonly tier: SteeringResourceRevision["layer"];
  readonly resource_order: number;
  readonly scope_evaluation: SteeringEvaluation;
  readonly inclusion_evaluation: SteeringEvaluation;
}
export interface SteeringOverrideDecision {
  readonly source: SteeringRuleReference;
  readonly target: SteeringRuleReference;
  readonly declaration: SteeringOverride;
  readonly scope: SteeringScope;
  readonly relation: "equal" | "narrower";
  readonly disposition: "supersede" | "compose";
}
export interface SteeringRuleRegion {
  readonly source: SteeringRuleReference;
  readonly scope: SteeringScope;
  readonly excluded_scopes: readonly SteeringScope[];
}
export interface SteeringEffectiveRule {
  readonly semantics: SteeringRule["semantics"];
  readonly authority: SteeringRule["authority"];
  readonly contributors: readonly SteeringApplicableRule[];
  readonly regions: readonly SteeringRuleRegion[];
  readonly enforcement: readonly SteeringEnforcementBinding[];
}
export interface SteeringResolvedBinding {
  readonly binding: SteeringEnforcementBinding;
  readonly sources: readonly { readonly resource: SteeringRevisionReference; readonly rule?: SteeringRuleId; readonly scope: SteeringScope }[];
}
export interface SteeringOmission {
  readonly resource: SteeringRevisionReference;
  readonly rule?: SteeringRuleId;
  readonly availability: "required" | "optional";
  readonly reason: "selector-miss" | "scope-miss" | "manual-unselected" | "unavailable" | "deprecated";
}
export interface SteeringResolutionTrace {
  readonly inputs: SteeringResolutionInputs;
  readonly hierarchy_order: readonly SteeringRevisionReference[];
  readonly included_resources: readonly SteeringIncludedResource[];
  readonly applicable_rules: readonly SteeringApplicableRule[];
  readonly omissions: readonly SteeringOmission[];
  readonly overrides: readonly SteeringOverrideDecision[];
  readonly shadowed_rules: readonly { readonly target: SteeringRuleReference; readonly by: SteeringRuleReference; readonly scope: SteeringScope; readonly coverage: "full" | "partial" }[];
}
interface ResultBase {
  readonly schema: typeof STEERING_RESOLVER_SCHEMA;
  readonly policy: typeof STEERING_RESOLVER_POLICY;
  readonly diagnostics: readonly SteeringResolutionIssue[];
}
export type SteeringResolutionResult = DeepReadonly<ResultBase & (
  | { status: "invalid-input" }
  | (SteeringResolutionTrace & { status: "conflicted" })
  | (SteeringResolutionTrace & { status: "resolved"; effective_rules: readonly SteeringEffectiveRule[]; enforcement: readonly SteeringResolvedBinding[] })
)>;
export type SteeringResolvedResult = Extract<SteeringResolutionResult, { readonly status: "resolved" }>;

export const steeringRuleReferenceSchema = z.strictObject({
  resource: steeringRevisionReferenceSchema,
  rule: steeringRuleIdSchema,
});
export const steeringRuleSubjectSchema = steeringRuleReferenceSchema.extend({
  scope: steeringScopeSchema,
  authority: steeringAuthoritySchema,
  override_policy: steeringOverridePolicySchema,
  semantics: steeringRuleSemanticsSchema,
  enforcement: z.array(steeringEnforcementBindingSchema),
});
const steeringEvaluationDeclarationSchema = z.union([steeringScopeSchema, steeringInclusionSelectorSchema]);
export const steeringEvaluationSchema: z.ZodType<SteeringEvaluation> = z.lazy(() => z.strictObject({
  declaration: steeringEvaluationDeclarationSchema,
  outcome: z.enum(["match", "miss", "error"]),
  children: z.array(steeringEvaluationSchema),
  matched_paths: z.array(exactPathSchema),
  missing: z.array(z.string()),
}));
export const steeringIncludedResourceSchema = z.strictObject({
  revision: steeringResourceRevisionSchema,
  tier: steeringLayerSchema,
  order: z.number().int().min(0),
  scope: steeringScopeSchema,
  reasons: z.array(z.strictObject({
    kind: z.enum(["selection", "manual", "parent"]),
    from: steeringRevisionReferenceSchema.optional(),
    evaluation: steeringEvaluationSchema,
  })),
  scope_evaluation: steeringEvaluationSchema,
  inclusion_evaluation: steeringEvaluationSchema,
});
export const steeringApplicableRuleSchema = steeringRuleSubjectSchema.extend({
  declaration: steeringRuleSchema,
  tier: steeringLayerSchema,
  resource_order: z.number().int().min(0),
  scope_evaluation: steeringEvaluationSchema,
  inclusion_evaluation: steeringEvaluationSchema,
});
export const steeringOverrideDecisionSchema = z.strictObject({
  source: steeringRuleReferenceSchema,
  target: steeringRuleReferenceSchema,
  declaration: steeringOverrideSchema,
  scope: steeringScopeSchema,
  relation: z.enum(["equal", "narrower"]),
  disposition: z.enum(["supersede", "compose"]),
});
export const steeringRuleRegionSchema = z.strictObject({
  source: steeringRuleReferenceSchema,
  scope: steeringScopeSchema,
  excluded_scopes: z.array(steeringScopeSchema),
});
export const steeringEffectiveRuleSchema = z.strictObject({
  semantics: steeringRuleSemanticsSchema,
  authority: steeringAuthoritySchema,
  contributors: z.array(steeringApplicableRuleSchema).min(1),
  regions: z.array(steeringRuleRegionSchema).min(1),
  enforcement: z.array(steeringEnforcementBindingSchema),
});
export const steeringResolvedBindingSchema = z.strictObject({
  binding: steeringEnforcementBindingSchema,
  sources: z.array(z.strictObject({
    resource: steeringRevisionReferenceSchema,
    rule: steeringRuleIdSchema.optional(),
    scope: steeringScopeSchema,
  })).min(1),
});
export const steeringOmissionSchema = z.strictObject({
  resource: steeringRevisionReferenceSchema,
  rule: steeringRuleIdSchema.optional(),
  availability: z.enum(["required", "optional"]),
  reason: z.enum(["selector-miss", "scope-miss", "manual-unselected", "unavailable", "deprecated"]),
});
export const steeringResolutionIssueSchema = z.strictObject({
  code: z.enum(steeringResolutionIssueCodes),
  severity: z.enum(["error", "warning"]),
  resource: steeringRevisionReferenceSchema.optional(),
  rule: steeringRuleIdSchema.optional(),
  semantic_key: steeringSemanticKeySchema.optional(),
  related: z.array(steeringRevisionReferenceSchema).optional(),
  rules: z.array(steeringRuleSubjectSchema).optional(),
  detail: z.string().optional(),
  override: steeringOverrideSchema.optional(),
});
export const steeringResolvedResultSchema = z.strictObject({
  schema: z.literal(STEERING_RESOLVER_SCHEMA),
  policy: z.literal(STEERING_RESOLVER_POLICY),
  status: z.literal("resolved"),
  diagnostics: z.array(steeringResolutionIssueSchema),
  inputs: steeringResolutionInputsSchema,
  hierarchy_order: z.array(steeringRevisionReferenceSchema),
  included_resources: z.array(steeringIncludedResourceSchema),
  applicable_rules: z.array(steeringApplicableRuleSchema),
  omissions: z.array(steeringOmissionSchema),
  overrides: z.array(steeringOverrideDecisionSchema),
  shadowed_rules: z.array(z.strictObject({
    target: steeringRuleReferenceSchema,
    by: steeringRuleReferenceSchema,
    scope: steeringScopeSchema,
    coverage: z.enum(["full", "partial"]),
  })),
  effective_rules: z.array(steeringEffectiveRuleSchema),
  enforcement: z.array(steeringResolvedBindingSchema),
});

export const sorted = <T>(items: readonly T[]): T[] => [...items].sort((a, b) => compareText(canonical(a), canonical(b)));
export const distinct = <T>(items: readonly T[]): T[] => sorted([...new Map(items.map((item) => [canonical(item), item])).values()]);
export const stableResolutionIssues = (issues: readonly SteeringResolutionIssue[]): SteeringResolutionIssue[] => distinct(issues.map((issue) => ({
  ...issue, ...(issue.related ? { related: distinct(issue.related) } : {}), ...(issue.rules ? { rules: distinct(issue.rules) } : {}),
})));
export function freezeResolution<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeResolution(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
export const ruleReference = (rule: SteeringRuleReference): SteeringRuleReference => ({ resource: rule.resource, rule: rule.rule });
export const ruleSubject = (rule: SteeringRuleSubject): SteeringRuleSubject => ({
  ...ruleReference(rule), scope: rule.scope, authority: rule.authority, override_policy: rule.override_policy,
  semantics: rule.semantics, enforcement: rule.enforcement,
});
