import { z } from "zod";
import { canonicalJSON, hashCanonical } from "../canonical-json";
import { operationIdSchema, type OperationId } from "../spec/domain/ids";
import { commitSequenceSchema } from "../spec/domain/generations";
import {
  canonical,
  channelSchema,
  compareText,
  contentHashSchema,
  exact,
  humanActorSchema,
  timestampSchema,
  type DeepReadonly,
} from "../spec/domain/primitives";
import {
  AGENTS_FILENAME,
  STEERING_AGENTS_CONTENT_ENCODING,
  STEERING_AGENTS_DISCOVERY_POLICY,
  STEERING_AGENTS_OBSERVATION_SCHEMA,
  STEERING_AGENTS_TEXT_ENCODING,
  agentsContentDescriptorSchema,
  agentsFilesystemObservationSchema,
  agentsInteropProvenanceSchema,
  agentsObservationChangeReasons,
  agentsObservationIdentitySchema,
  agentsProjectIdentitySchema,
  agentsScopeDepth,
  agentsScopeRootForSourcePath,
  agentsScopeRootSchema,
  agentsScopeSchema,
  agentsSourceIdentitySchema,
  agentsSourcePathSchema,
} from "../steering-agents/types";
import { steeringInclusionSchema, steeringScopeSchema } from "../steering/applicability";
import { profileReferenceSchema } from "../spec/domain/primitives";
import {
  steeringCustomCategorySchema,
  steeringResourceIdSchema,
  steeringRevisionReferenceSchema,
  type SteeringGeneration,
  type SteeringResourceId,
  type SteeringRevisionReference,
} from "../steering/ids";
import {
  steeringAgentsImportPolicyPinSchema,
  steeringProjectNamespaceSchema,
  steeringProvenanceSchema,
} from "../steering/schema";
import {
  steeringHeadSchema,
  steeringResourceExpectationSchema,
} from "../storage/steering-types";

export const STEERING_AGENTS_IMPORT_POLICY = "aira.dev/steering-agents-import-policy/v1" as const;
export const STEERING_AGENTS_IMPORT_MAPPING_SCHEMA = "aira.dev/steering-agents-import-mapping/v1" as const;
export const STEERING_AGENTS_IMPORT_PLAN_SCHEMA = "aira.dev/steering-agents-import-plan/v1" as const;
export const STEERING_AGENTS_IMPORT_AUTHORIZATION_SCHEMA = "aira.dev/steering-agents-import-authorization/v1" as const;
export const STEERING_AGENTS_IMPORT_RESULT_SCHEMA = "aira.dev/steering-agents-import-result/v1" as const;
export const STEERING_AGENTS_IMPORT_OPERATION_CONTRACT = "aira.dev/steering-agents-import-operation/v1" as const;
export const STEERING_AGENTS_IMPORT_ORDERING = "broadest-to-nearest-scope-depth-then-source-path/v1" as const;

function deepFreezeStatic<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeStatic(child);
    Object.freeze(value);
  }
  return value;
}

const agentsImportPolicyDefinition = {
  contract: STEERING_AGENTS_IMPORT_POLICY,
  identity: {
    mapping_contract: STEERING_AGENTS_IMPORT_MAPPING_SCHEMA,
    root_resource: "interop.steering.agents-md",
    nested_resource: "sha256-location-split-32-32/v1",
    source_location: "validated-project-relative-agents-path-and-scope/v1",
    revision_evolution: "same-location-successor; moved-location-new-resource; no-auto-retire/v1",
  },
  representation: {
    kind: "custom",
    custom_kind: "agents.interoperability",
    layer: "interoperability",
    provenance: "interoperability",
    body: "exact-observed-raw-bytes/v1",
    default_authority: "normative",
    authority_ceiling: ["descriptive", "normative"],
    default_override_policy: "sealed",
    structured_rules: "none",
    enforcement: "none",
    composition: "none",
  },
  applicability: {
    root_scope: "project-global",
    nested_scope: "path-tree",
    inclusion_availability: "required",
    inclusion_selector: "always",
    phases: "all-steering-phases",
  },
  composition: {
    nested_guidance_order: STEERING_AGENTS_IMPORT_ORDERING,
    semantic_precedence: "none",
  },
} as const;

export const STEERING_AGENTS_IMPORT_POLICY_HASH = hashCanonical(agentsImportPolicyDefinition);
export const agentsImportPolicy = deepFreezeStatic({
  ...agentsImportPolicyDefinition,
  hash: STEERING_AGENTS_IMPORT_POLICY_HASH,
});

export const steeringAgentsImportPolicySchema = z.strictObject({
  contract: z.literal(STEERING_AGENTS_IMPORT_POLICY),
  identity: z.strictObject({
    mapping_contract: z.literal(STEERING_AGENTS_IMPORT_MAPPING_SCHEMA),
    root_resource: z.literal("interop.steering.agents-md"),
    nested_resource: z.literal("sha256-location-split-32-32/v1"),
    source_location: z.literal("validated-project-relative-agents-path-and-scope/v1"),
    revision_evolution: z.literal("same-location-successor; moved-location-new-resource; no-auto-retire/v1"),
  }),
  representation: z.strictObject({
    kind: z.literal("custom"),
    custom_kind: z.literal("agents.interoperability"),
    layer: z.literal("interoperability"),
    provenance: z.literal("interoperability"),
    body: z.literal("exact-observed-raw-bytes/v1"),
    default_authority: z.literal("normative"),
    authority_ceiling: z.tuple([z.literal("descriptive"), z.literal("normative")]),
    default_override_policy: z.literal("sealed"),
    structured_rules: z.literal("none"),
    enforcement: z.literal("none"),
    composition: z.literal("none"),
  }),
  applicability: z.strictObject({
    root_scope: z.literal("project-global"),
    nested_scope: z.literal("path-tree"),
    inclusion_availability: z.literal("required"),
    inclusion_selector: z.literal("always"),
    phases: z.literal("all-steering-phases"),
  }),
  composition: z.strictObject({
    nested_guidance_order: z.literal(STEERING_AGENTS_IMPORT_ORDERING),
    semantic_precedence: z.literal("none"),
  }),
  hash: contentHashSchema,
});
export type SteeringAgentsImportPolicy = DeepReadonly<z.infer<typeof steeringAgentsImportPolicySchema>>;

export const agentsImportPolicyPin = steeringAgentsImportPolicyPinSchema.parse({
  contract: STEERING_AGENTS_IMPORT_POLICY,
  hash: STEERING_AGENTS_IMPORT_POLICY_HASH,
});

/** Exact adapter profile identifier for this static mapping policy, not an enforcement mechanism. */
export const agentsImportAdapterProfile = profileReferenceSchema.parse({
  id: "profile_steering-agents-import-v1",
  revision: "rev_v1",
  hash: STEERING_AGENTS_IMPORT_POLICY_HASH,
});

/**
 * A canonical plan-safe projection of a 05C-4B1 observation. The raw bytes are
 * intentionally not duplicated in a plan: their exact hash and byte count are
 * bound here, and apply re-observes and verifies the bytes before publication.
 */
export const steeringAgentsImportObservationSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_OBSERVATION_SCHEMA),
  discovery_policy: z.literal(STEERING_AGENTS_DISCOVERY_POLICY),
  project: agentsProjectIdentitySchema,
  control: z.strictObject({ root: z.literal(".") }),
  source_path: agentsSourcePathSchema,
  source_identity: agentsSourceIdentitySchema,
  observation_identity: agentsObservationIdentitySchema,
  scope: agentsScopeSchema,
  source: agentsContentDescriptorSchema,
  content_encoding: z.literal(STEERING_AGENTS_CONTENT_ENCODING),
  text_encoding: z.literal(STEERING_AGENTS_TEXT_ENCODING),
  filesystem: agentsFilesystemObservationSchema,
  provenance: agentsInteropProvenanceSchema,
}).superRefine((value, ctx) => {
  const scopeRoot = agentsScopeRootForSourcePath(value.source_path);
  if (scopeRoot === undefined || value.scope.root !== scopeRoot || value.scope.depth !== agentsScopeDepth(scopeRoot))
    ctx.addIssue({ code: "custom", path: ["scope"], message: "agents-import-observation-scope-mismatch" });
  if (value.provenance.source_path !== value.source_path || value.provenance.source_hash !== value.source.hash ||
    value.provenance.scope_root !== value.scope.root || value.provenance.discovery_policy !== value.discovery_policy)
    ctx.addIssue({ code: "custom", path: ["provenance"], message: "agents-import-observation-provenance-mismatch" });
});
export type SteeringAgentsImportObservation = DeepReadonly<z.infer<typeof steeringAgentsImportObservationSchema>>;

export const steeringAgentsImportMappingSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_IMPORT_MAPPING_SCHEMA),
  policy: steeringAgentsImportPolicyPinSchema,
  source_location: z.strictObject({
    source_type: z.literal(AGENTS_FILENAME),
    source_path: agentsSourcePathSchema,
    source_identity: agentsSourceIdentitySchema,
    scope_root: agentsScopeRootSchema,
  }),
  resource: steeringResourceIdSchema,
  representation: z.strictObject({
    kind: z.literal("custom"),
    custom_kind: steeringCustomCategorySchema,
    layer: z.literal("interoperability"),
    default_authority: z.literal("normative"),
    default_override_policy: z.literal("sealed"),
    default_enforcement: z.tuple([]),
    rules: z.tuple([]),
    composition: z.strictObject({ parents: z.tuple([]), overrides: z.tuple([]) }),
    compatibility: z.strictObject({
      resolver: z.literal("aira.dev/steering-resolution/v1"),
      required_schemas: z.tuple([]),
    }),
    metadata: z.strictObject({
      title: z.literal("AGENTS.md interoperability guidance"),
      description: z.literal("Exact imported AGENTS.md interoperability guidance."),
      labels: z.tuple([z.literal("agents-md"), z.literal("interoperability")]),
    }),
    behavioral_assets: z.tuple([]),
  }),
  scope: steeringScopeSchema,
  inclusion: steeringInclusionSchema,
  ordering: z.literal(STEERING_AGENTS_IMPORT_ORDERING),
}).superRefine((value, ctx) => {
  const expectedScope = agentsScopeRootForSourcePath(value.source_location.source_path);
  if (expectedScope === undefined || value.source_location.scope_root !== expectedScope)
    ctx.addIssue({ code: "custom", path: ["source_location", "scope_root"], message: "agents-import-mapping-scope-mismatch" });
});
export type SteeringAgentsImportMapping = DeepReadonly<z.infer<typeof steeringAgentsImportMappingSchema>>;

function expectedAgentsImportResourceId(sourcePath: string, scopeRoot: string): SteeringResourceId | undefined {
  if (sourcePath === AGENTS_FILENAME && scopeRoot === ".") return steeringResourceIdSchema.parse("interop.steering.agents-md");
  const expectedScope = agentsScopeRootForSourcePath(sourcePath);
  if (expectedScope === undefined || expectedScope !== scopeRoot) return undefined;
  const digest = hashCanonical({
    contract: STEERING_AGENTS_IMPORT_MAPPING_SCHEMA,
    policy: STEERING_AGENTS_IMPORT_POLICY,
    source_type: AGENTS_FILENAME,
    source_path: sourcePath,
    scope_root: scopeRoot,
  }).slice("sha256:".length);
  return steeringResourceIdSchema.parse(
    `interop.steering.agents-md.location-${digest.slice(0, 32)}.hash-${digest.slice(32)}`,
  );
}

function expectedAgentsImportScope(scopeRoot: string): unknown {
  return scopeRoot === "." ? { kind: "project-global" } :
    { kind: "path", selectors: [{ kind: "tree", path: scopeRoot }] };
}

function expectedAgentsImportRepresentation(): unknown {
  return {
    kind: "custom",
    custom_kind: "agents.interoperability",
    layer: "interoperability",
    default_authority: "normative",
    default_override_policy: "sealed",
    default_enforcement: [],
    rules: [],
    composition: { parents: [], overrides: [] },
    compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: [] },
    metadata: {
      title: "AGENTS.md interoperability guidance",
      description: "Exact imported AGENTS.md interoperability guidance.",
      labels: ["agents-md", "interoperability"],
    },
    behavioral_assets: [],
  };
}

function mappingMatchesObservation(
  mapping: z.infer<typeof steeringAgentsImportMappingSchema>,
  observation: z.infer<typeof steeringAgentsImportObservationSchema>,
): boolean {
  const expectedResource = expectedAgentsImportResourceId(observation.source_path, observation.scope.root);
  return expectedResource !== undefined && mapping.schema === STEERING_AGENTS_IMPORT_MAPPING_SCHEMA &&
    exact(mapping.policy, agentsImportPolicyPin) && mapping.source_location.source_type === AGENTS_FILENAME &&
    mapping.source_location.source_path === observation.source_path &&
    mapping.source_location.source_identity === observation.source_identity &&
    mapping.source_location.scope_root === observation.scope.root && mapping.resource === expectedResource &&
    exact(mapping.representation, expectedAgentsImportRepresentation()) &&
    exact(mapping.scope, expectedAgentsImportScope(observation.scope.root)) &&
    exact(mapping.inclusion, { availability: "required", selector: { kind: "always" } }) &&
    mapping.ordering === STEERING_AGENTS_IMPORT_ORDERING;
}

export const steeringAgentsImportSourceSchema = z.strictObject({
  observation: steeringAgentsImportObservationSchema,
  mapping: steeringAgentsImportMappingSchema,
  authoritative_provenance: steeringProvenanceSchema,
}).superRefine((value, ctx) => {
  if (!mappingMatchesObservation(value.mapping, value.observation))
    ctx.addIssue({ code: "custom", message: "agents-import-source-mapping-mismatch" });
  const provenance = value.authoritative_provenance;
  const expectedAttribution = {
    schema: value.observation.schema,
    discovery_policy: value.observation.discovery_policy,
    project: value.observation.project,
    control: value.observation.control,
    source_path: value.observation.source_path,
    source_identity: value.observation.source_identity,
    observation_identity: value.observation.observation_identity,
    scope: value.observation.scope,
    source: value.observation.source,
    content_encoding: value.observation.content_encoding,
    text_encoding: value.observation.text_encoding,
    provenance: value.observation.provenance,
  };
  if (provenance.kind !== "interoperability" || provenance.source.kind !== "agents-md" ||
    provenance.source.source_identity !== value.observation.source_identity ||
    provenance.source.source_revision !== value.observation.observation_identity ||
    provenance.source.hash !== value.observation.source.hash || !exact(provenance.source.adapter, agentsImportAdapterProfile) ||
    provenance.source.import_policy === undefined || !exact(provenance.source.import_policy, agentsImportPolicyPin) ||
    provenance.source.agents_observation === undefined || !exact(provenance.source.agents_observation, expectedAttribution))
    ctx.addIssue({ code: "custom", message: "agents-import-source-provenance-mismatch" });
});
export type SteeringAgentsImportSource = DeepReadonly<z.infer<typeof steeringAgentsImportSourceSchema>>;

export const steeringAgentsImportPlanIdSchema = z.string()
  .regex(/^steering_agents_import_plan_[a-f0-9]{64}$/, "invalid-steering-agents-import-plan-id")
  .brand<"SteeringAgentsImportPlanId">();
export const steeringAgentsImportActionIdSchema = z.string()
  .regex(/^steering_agents_import_action_[a-f0-9]{64}$/, "invalid-steering-agents-import-action-id")
  .brand<"SteeringAgentsImportActionId">();
export type SteeringAgentsImportPlanId = z.infer<typeof steeringAgentsImportPlanIdSchema>;
export type SteeringAgentsImportActionId = z.infer<typeof steeringAgentsImportActionIdSchema>;

export const steeringAgentsImportIssueCodes = [
  "agents-import-plan-invalid",
  "agents-import-source-stale",
  "agents-import-source-missing",
  "agents-import-source-unsafe",
  "agents-import-registry-stale",
  "agents-import-authorization-required",
  "agents-import-worker-unauthorized",
  "agents-import-mapping-conflict",
  "agents-import-resource-collision",
  "agents-import-authority-invalid",
  "agents-import-enforcement-forbidden",
  "agents-import-partial-selection-invalid",
  "agents-import-no-op",
] as const;
export type SteeringAgentsImportIssueCode = typeof steeringAgentsImportIssueCodes[number];

export const steeringAgentsImportFreshnessReasons = [
  ...agentsObservationChangeReasons,
  "observation-identity-changed",
] as const;
export type SteeringAgentsImportFreshnessReason = typeof steeringAgentsImportFreshnessReasons[number];

export const steeringAgentsImportIssueSchema = z.strictObject({
  code: z.enum(steeringAgentsImportIssueCodes),
  resource: steeringResourceIdSchema.optional(),
  action: steeringAgentsImportActionIdSchema.optional(),
  source_path: agentsSourcePathSchema.optional(),
  detail: z.string().optional(),
  reasons: z.array(z.enum(steeringAgentsImportFreshnessReasons)).optional(),
});
export type SteeringAgentsImportIssue = DeepReadonly<z.infer<typeof steeringAgentsImportIssueSchema>>;

export const steeringAgentsImportComparisonSchema = z.strictObject({
  body: z.enum(["unchanged", "changed"]),
  source: z.enum(["unchanged", "changed"]),
  mapping: z.enum(["unchanged", "changed"]),
  representation: z.enum(["unchanged", "changed"]),
  authority: z.enum(["unchanged", "changed"]),
  scope: z.enum(["unchanged", "changed"]),
  inclusion: z.enum(["unchanged", "changed"]),
  composition: z.enum(["unchanged", "changed"]),
  rules: z.enum(["unchanged", "changed"]),
  enforcement: z.enum(["unchanged", "changed"]),
  compatibility: z.enum(["unchanged", "changed"]),
});
export type SteeringAgentsImportComparison = DeepReadonly<z.infer<typeof steeringAgentsImportComparisonSchema>>;

const absentExpectationSchema = z.strictObject({ id: steeringResourceIdSchema, status: z.literal("absent") });
const activeExpectationSchema = z.strictObject({
  id: steeringResourceIdSchema,
  status: z.literal("active"),
  current: steeringRevisionReferenceSchema,
});
const retiredExpectationSchema = z.strictObject({ id: steeringResourceIdSchema, status: z.literal("retired") });

const actionBase = {
  action_id: steeringAgentsImportActionIdSchema,
  resource: steeringResourceIdSchema,
  source: steeringAgentsImportSourceSchema,
  comparison: steeringAgentsImportComparisonSchema,
};
export const steeringAgentsImportActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...actionBase,
    kind: z.literal("create"),
    expectation: absentExpectationSchema,
    next: steeringRevisionReferenceSchema,
  }),
  z.strictObject({
    ...actionBase,
    kind: z.literal("update"),
    expectation: activeExpectationSchema,
    supersedes: steeringRevisionReferenceSchema,
    next: steeringRevisionReferenceSchema,
  }),
  z.strictObject({
    ...actionBase,
    kind: z.literal("unchanged"),
    expectation: activeExpectationSchema,
    current: steeringRevisionReferenceSchema,
  }),
  z.strictObject({
    ...actionBase,
    kind: z.literal("conflict"),
    expectation: z.union([absentExpectationSchema, activeExpectationSchema, retiredExpectationSchema]),
    issues: z.array(steeringAgentsImportIssueSchema).min(1),
  }),
]).superRefine((action, ctx) => {
  if (action.resource !== action.source.mapping.resource || action.resource !== action.expectation.id)
    ctx.addIssue({ code: "custom", message: "agents-import-action-resource-mismatch" });
  if (action.kind === "create" && (action.next.id !== action.resource || action.next.revision !== "1" ||
    action.next.hash !== action.source.observation.source.hash))
    ctx.addIssue({ code: "custom", message: "agents-import-create-revision-invalid" });
  if (action.kind === "update" && (action.supersedes.id !== action.resource || !exact(action.supersedes, action.expectation.current) ||
    action.next.id !== action.resource || action.next.hash !== action.source.observation.source.hash))
    ctx.addIssue({ code: "custom", message: "agents-import-update-revision-invalid" });
  if (action.kind === "unchanged" && !exact(action.current, action.expectation.current))
    ctx.addIssue({ code: "custom", message: "agents-import-unchanged-current-mismatch" });
});
export type SteeringAgentsImportAction = DeepReadonly<z.infer<typeof steeringAgentsImportActionSchema>>;
export type SteeringAgentsImportPublicationAction = Extract<SteeringAgentsImportAction, { readonly kind: "create" | "update" }>;

const canonicalExpectationOrder = (values: readonly z.infer<typeof steeringResourceExpectationSchema>[]): boolean =>
  values.every((value, index) => index === 0 || compareText(values[index - 1]!.id, value.id) < 0);
export const steeringAgentsImportRegistryObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("absent"), project: steeringProjectNamespaceSchema }),
  z.strictObject({
    status: z.literal("present"),
    project: steeringProjectNamespaceSchema,
    head: steeringHeadSchema,
    commit_sequence: commitSequenceSchema,
    steering_generation: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-agents-import-steering-generation"),
    resources: z.array(steeringResourceExpectationSchema).refine(canonicalExpectationOrder,
      "noncanonical-agents-import-resource-observation-order"),
  }).superRefine((value, ctx) => {
    if (value.head.project !== value.project || value.head.sequence !== value.commit_sequence ||
      value.head.steering_generation !== value.steering_generation)
      ctx.addIssue({ code: "custom", message: "agents-import-registry-head-mismatch" });
  }),
]);
export type SteeringAgentsImportRegistryObservation = DeepReadonly<z.infer<typeof steeringAgentsImportRegistryObservationSchema>>;

export const steeringAgentsImportAuthorizationRequirementSchema = z.strictObject({
  required: z.literal(true),
  contract: z.literal(STEERING_AGENTS_IMPORT_AUTHORIZATION_SCHEMA),
  actor_kind: z.literal("human"),
  worker_self_modification: z.literal("forbidden"),
});
export const steeringAgentsImportOperationRequirementSchema = z.strictObject({
  required: z.literal(true),
  contract: z.literal(STEERING_AGENTS_IMPORT_OPERATION_CONTRACT),
  storage_idempotency: z.literal("steering-store-operation-id/v1"),
});

const canonicalActionOrder = (values: readonly SteeringAgentsImportAction[]): boolean => values.every((value, index) =>
  index === 0 || compareText(values[index - 1]!.resource, value.resource) < 0);
const canonicalActionIds = (values: readonly SteeringAgentsImportActionId[]): boolean => values.every((value, index) =>
  index === 0 || compareText(values[index - 1]!, value) < 0);

export const steeringAgentsImportPlanSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_IMPORT_PLAN_SCHEMA),
  id: steeringAgentsImportPlanIdSchema,
  hash: contentHashSchema,
  project: steeringProjectNamespaceSchema,
  control: z.strictObject({ root: z.literal(".") }),
  discovery: z.strictObject({
    policy: z.literal(STEERING_AGENTS_DISCOVERY_POLICY),
    observation_schema: z.literal(STEERING_AGENTS_OBSERVATION_SCHEMA),
  }),
  policy: steeringAgentsImportPolicySchema,
  registry: steeringAgentsImportRegistryObservationSchema,
  actions: z.array(steeringAgentsImportActionSchema).refine(canonicalActionOrder,
    "noncanonical-agents-import-action-order"),
  selection: z.strictObject({
    action_ids: z.array(steeringAgentsImportActionIdSchema).refine(canonicalActionIds,
      "noncanonical-agents-import-selection-order"),
  }),
  authorization: steeringAgentsImportAuthorizationRequirementSchema,
  operation: steeringAgentsImportOperationRequirementSchema,
}).superRefine((plan, ctx) => {
  if (plan.registry.project !== plan.project)
    ctx.addIssue({ code: "custom", path: ["registry", "project"], message: "agents-import-plan-project-mismatch" });
  const actions = new Map(plan.actions.map((action) => [action.action_id, action]));
  if (new Set(plan.selection.action_ids).size !== plan.selection.action_ids.length)
    ctx.addIssue({ code: "custom", path: ["selection", "action_ids"], message: "agents-import-plan-selection-duplicate" });
  for (const actionId of plan.selection.action_ids) {
    const action = actions.get(actionId);
    if (action === undefined || action.kind === "conflict")
      ctx.addIssue({ code: "custom", path: ["selection", "action_ids"], message: "agents-import-plan-selection-invalid" });
  }
  const resources = new Set<string>(), sources = new Set<string>();
  for (const action of plan.actions) {
    if (action.source.observation.project !== plan.project || action.source.mapping.policy.contract !== plan.policy.contract ||
      action.source.mapping.policy.hash !== plan.policy.hash)
      ctx.addIssue({ code: "custom", path: ["actions"], message: "agents-import-plan-source-project-or-policy-mismatch" });
    if (resources.has(action.resource) || sources.has(action.source.observation.source_path))
      ctx.addIssue({ code: "custom", path: ["actions"], message: "agents-import-plan-resource-or-source-duplicate" });
    resources.add(action.resource); sources.add(action.source.observation.source_path);
  }
});
export type SteeringAgentsImportPlan = DeepReadonly<z.infer<typeof steeringAgentsImportPlanSchema>>;

export const steeringAgentsImportAuthorizationSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_IMPORT_AUTHORIZATION_SCHEMA),
  project: steeringProjectNamespaceSchema,
  plan: z.strictObject({ id: steeringAgentsImportPlanIdSchema, hash: contentHashSchema }),
  by: humanActorSchema,
  decided_at: timestampSchema,
  channel: channelSchema.optional(),
});
export type SteeringAgentsImportAuthorization = DeepReadonly<z.infer<typeof steeringAgentsImportAuthorizationSchema>>;

const importHeadStateSchema = z.strictObject({
  head: steeringHeadSchema.nullable(),
  steering_generation: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-agents-import-result-generation").nullable(),
});
export const steeringAgentsImportResultSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_IMPORT_RESULT_SCHEMA),
  status: z.enum(["committed", "replayed", "no-op"]),
  plan: z.strictObject({ id: steeringAgentsImportPlanIdSchema, hash: contentHashSchema }),
  operation: operationIdSchema,
  committed: z.boolean(),
  replayed: z.boolean(),
  previous: importHeadStateSchema,
  current: importHeadStateSchema,
  created_resources: z.array(steeringRevisionReferenceSchema),
  updated_resources: z.array(steeringRevisionReferenceSchema),
  unchanged_resources: z.array(steeringResourceIdSchema),
  authoritative_commit: contentHashSchema.nullable(),
  source_observations: z.array(steeringAgentsImportObservationSchema),
  diagnostics: z.array(steeringAgentsImportIssueSchema),
});
export type SteeringAgentsImportResult = DeepReadonly<z.infer<typeof steeringAgentsImportResultSchema>>;

export type SteeringAgentsImportPlanResult =
  | { readonly ok: true; readonly plan: SteeringAgentsImportPlan }
  | { readonly ok: false; readonly issues: readonly SteeringAgentsImportIssue[] };
export type SteeringAgentsImportApplyResult =
  | { readonly ok: true; readonly result: SteeringAgentsImportResult }
  | { readonly ok: false; readonly issues: readonly SteeringAgentsImportIssue[] };

export function steeringAgentsImportActionSemantic(action: SteeringAgentsImportAction): unknown {
  const { action_id: _actionId, ...semantic } = action;
  return semantic;
}

export function steeringAgentsImportActionId(
  action: Omit<SteeringAgentsImportAction, "action_id"> | SteeringAgentsImportAction,
): SteeringAgentsImportActionId {
  const { action_id: _actionId, ...withoutId } = action as SteeringAgentsImportAction;
  const hash = hashCanonical({
    contract: "aira.dev/steering-agents-import-action/v1",
    action: steeringAgentsImportActionSemantic(withoutId as SteeringAgentsImportAction),
  });
  return steeringAgentsImportActionIdSchema.parse(`steering_agents_import_action_${hash.slice("sha256:".length)}`);
}

export function steeringAgentsImportPlanSemantic(plan: SteeringAgentsImportPlan): unknown {
  const { id: _id, hash: _hash, actions, ...rest } = plan;
  return { ...rest, actions: actions.map(steeringAgentsImportActionSemantic) };
}

export function steeringAgentsImportPlanHash(plan: SteeringAgentsImportPlan): z.infer<typeof contentHashSchema> {
  return hashCanonical(steeringAgentsImportPlanSemantic(plan));
}

export function steeringAgentsImportPlanIdFromHash(hash: z.infer<typeof contentHashSchema>): SteeringAgentsImportPlanId {
  return steeringAgentsImportPlanIdSchema.parse(`steering_agents_import_plan_${hash.slice("sha256:".length)}`);
}

export function stableSteeringAgentsImportIssues(issues: readonly SteeringAgentsImportIssue[]): SteeringAgentsImportIssue[] {
  return [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Canonical detachment makes a reviewed plan immutable and JSON-only. */
export function freezeSteeringAgentsImport<T>(value: T): DeepReadonly<T> {
  return deepFreeze(JSON.parse(canonicalJSON(value)) as T);
}

export function validateSteeringAgentsImportPlan(value: unknown): readonly SteeringAgentsImportIssue[] {
  const parsed = steeringAgentsImportPlanSchema.safeParse(value);
  if (!parsed.success) return stableSteeringAgentsImportIssues([{
    code: "agents-import-plan-invalid",
    detail: parsed.error.issues[0]?.path.map(String).join(".") || parsed.error.issues[0]?.message,
  }]);
  const plan = parsed.data as SteeringAgentsImportPlan;
  const issues: SteeringAgentsImportIssue[] = [];
  if (!exact(plan.policy, agentsImportPolicy))
    issues.push({ code: "agents-import-plan-invalid", detail: "import-policy-mismatch" });
  const expectedHash = steeringAgentsImportPlanHash(plan);
  if (plan.hash !== expectedHash || plan.id !== steeringAgentsImportPlanIdFromHash(expectedHash))
    issues.push({ code: "agents-import-plan-invalid", detail: "semantic-identity-mismatch" });
  const resources = new Map<string, SteeringAgentsImportAction>();
  for (const action of plan.actions) {
    const expectedAction = steeringAgentsImportActionId(action);
    if (action.action_id !== expectedAction)
      issues.push({ code: "agents-import-plan-invalid", resource: action.resource, action: action.action_id,
        detail: "action-identity-mismatch" });
    const previous = resources.get(action.resource);
    if (previous !== undefined && previous.source.observation.source_path !== action.source.observation.source_path)
      issues.push({ code: "agents-import-resource-collision", resource: action.resource,
        source_path: action.source.observation.source_path,
        detail: "multiple-source-locations-map-to-one-resource" });
    resources.set(action.resource, action);
    if (action.resource !== action.source.mapping.resource ||
      action.source.mapping.source_location.source_path !== action.source.observation.source_path ||
      action.source.mapping.source_location.source_identity !== action.source.observation.source_identity ||
      action.source.mapping.source_location.scope_root !== action.source.observation.scope.root)
      issues.push({ code: "agents-import-plan-invalid", resource: action.resource, action: action.action_id,
        source_path: action.source.observation.source_path, detail: "source-mapping-mismatch" });
  }
  return stableSteeringAgentsImportIssues(issues);
}

export interface SteeringAgentsImportPlanInput {
  readonly inspection: import("../steering-agents").AgentsInteropInspection;
  readonly registry: import("../storage/steering-types").SteeringStoreSnapshot | null;
  /** Exact logical AGENTS.md source paths resolved into immutable action IDs during planning. */
  readonly selection?: readonly string[];
}

export interface InspectAndPlanSteeringAgentsImportInput {
  readonly project_root: string;
  readonly project: string;
  readonly store: import("../storage/steering-store").SteeringStore;
  readonly selection?: readonly string[];
}

export interface SteeringAgentsImportApplyInput {
  readonly project_root: string;
  readonly store: import("../storage/steering-store").SteeringStore;
  readonly plan: unknown;
  readonly authorization?: unknown;
  readonly operation: OperationId | unknown;
}

export interface SteeringAgentsImportRegistryState {
  readonly head: z.infer<typeof steeringHeadSchema> | null;
  readonly steering_generation: SteeringGeneration | null;
}
