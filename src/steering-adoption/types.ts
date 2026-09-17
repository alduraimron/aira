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
  steeringGenerationSchema,
  steeringResourceIdSchema,
  steeringRevisionReferenceSchema,
  type SteeringGeneration,
  type SteeringResourceId,
  type SteeringRevisionReference,
} from "../steering/ids";
import { steeringProjectNamespaceSchema, steeringProvenanceSchema } from "../steering/schema";
import {
  STEERING_NATIVE_DISCOVERY_POLICY,
  STEERING_SOURCE_OBSERVATION_SCHEMA,
  STEERING_SOURCE_SCHEMA,
  STEERING_SOURCE_ROOT,
  steeringSourceObservationChangeReasons,
  steeringSourceObservationSchema,
  steeringSourceProposalSchema,
  type SteeringSourceObservation,
} from "../steering-source";
import {
  steeringHeadSchema,
  steeringResourceExpectationSchema,
} from "../storage/steering-types";

export const STEERING_ADOPTION_PLAN_SCHEMA = "aira.dev/steering-adoption-plan/v1" as const;
export const STEERING_ADOPTION_AUTHORIZATION_SCHEMA = "aira.dev/steering-adoption-authorization/v1" as const;
export const STEERING_ADOPTION_RESULT_SCHEMA = "aira.dev/steering-adoption-result/v1" as const;
export const STEERING_ADOPTION_OPERATION_CONTRACT = "aira.dev/steering-adoption-operation/v1" as const;

export const steeringAdoptionPlanIdSchema = z.string()
  .regex(/^steering_adoption_plan_[a-f0-9]{64}$/, "invalid-steering-adoption-plan-id")
  .brand<"SteeringAdoptionPlanId">();
export const steeringAdoptionActionIdSchema = z.string()
  .regex(/^steering_adoption_action_[a-f0-9]{64}$/, "invalid-steering-adoption-action-id")
  .brand<"SteeringAdoptionActionId">();

export type SteeringAdoptionPlanId = z.infer<typeof steeringAdoptionPlanIdSchema>;
export type SteeringAdoptionActionId = z.infer<typeof steeringAdoptionActionIdSchema>;

export const steeringAdoptionIssueCodes = [
  "adoption-plan-invalid",
  "adoption-plan-source-stale",
  "adoption-plan-registry-stale",
  "adoption-source-missing",
  "adoption-source-unsafe",
  "adoption-authorization-required",
  "adoption-worker-unauthorized",
  "adoption-resource-conflict",
  "adoption-partial-selection-invalid",
  "adoption-cross-reference-invalid",
  "adoption-retired-id-reuse",
  "adoption-no-op",
] as const;
export type SteeringAdoptionIssueCode = typeof steeringAdoptionIssueCodes[number];

export const steeringAdoptionIssueSchema = z.strictObject({
  code: z.enum(steeringAdoptionIssueCodes),
  resource: steeringResourceIdSchema.optional(),
  action: steeringAdoptionActionIdSchema.optional(),
  source_path: z.string().optional(),
  detail: z.string().optional(),
  reasons: z.array(z.enum(steeringSourceObservationChangeReasons)).optional(),
});
export type SteeringAdoptionIssue = DeepReadonly<z.infer<typeof steeringAdoptionIssueSchema>>;

/** The exact inspected source and the project provenance that publication will carry. */
export const steeringAdoptionSourceSchema = z.strictObject({
  observation: steeringSourceObservationSchema,
  proposal: steeringSourceProposalSchema,
  authoritative_provenance: steeringProvenanceSchema,
}).superRefine((value, ctx) => {
  const source = value.observation;
  if (source.identity.id !== value.proposal.identity.id || source.body.hash !== value.proposal.content.hash ||
    source.body.bytes !== value.proposal.content.bytes || source.metadata_hash !== value.proposal.source_metadata_hash)
    ctx.addIssue({ code: "custom", message: "adoption-source-proposal-mismatch" });
  if (value.authoritative_provenance.kind !== "project" ||
    value.authoritative_provenance.project !== source.project ||
    value.authoritative_provenance.authorship !== source.provenance.authorship ||
    !exact(value.authoritative_provenance.adopted_from, source.provenance.adopted_from) ||
    !exact(value.authoritative_provenance.native_source, source))
    ctx.addIssue({ code: "custom", message: "adoption-source-provenance-mismatch" });
});
export type SteeringAdoptionSource = DeepReadonly<z.infer<typeof steeringAdoptionSourceSchema>>;

export const steeringAdoptionComparisonSchema = z.strictObject({
  body: z.enum(["unchanged", "changed"]),
  metadata: z.enum(["unchanged", "changed"]),
  rules: z.enum(["unchanged", "changed"]),
  provenance: z.enum(["unchanged", "changed"]),
});
export type SteeringAdoptionComparison = DeepReadonly<z.infer<typeof steeringAdoptionComparisonSchema>>;

const absentExpectationSchema = z.strictObject({
  id: steeringResourceIdSchema,
  status: z.literal("absent"),
});
const activeExpectationSchema = z.strictObject({
  id: steeringResourceIdSchema,
  status: z.literal("active"),
  current: steeringRevisionReferenceSchema,
});
const retiredExpectationSchema = z.strictObject({
  id: steeringResourceIdSchema,
  status: z.literal("retired"),
});

const actionBase = {
  action_id: steeringAdoptionActionIdSchema,
  resource: steeringResourceIdSchema,
  source: steeringAdoptionSourceSchema,
  comparison: steeringAdoptionComparisonSchema,
};
export const steeringAdoptionActionSchema = z.discriminatedUnion("kind", [
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
    issues: z.array(steeringAdoptionIssueSchema).min(1),
  }),
]).superRefine((action, ctx) => {
  if (action.resource !== action.source.observation.identity.id || action.resource !== action.source.proposal.identity.id ||
    action.resource !== action.expectation.id)
    ctx.addIssue({ code: "custom", message: "adoption-action-resource-mismatch" });
  if (action.kind === "create" && (action.next.id !== action.resource || action.next.hash !== action.source.observation.body.hash ||
    action.next.revision !== "1"))
    ctx.addIssue({ code: "custom", message: "adoption-create-revision-invalid" });
  if (action.kind === "update" && (action.supersedes.id !== action.resource || !exact(action.supersedes, action.expectation.current) ||
    action.next.id !== action.resource || action.next.hash !== action.source.observation.body.hash))
    ctx.addIssue({ code: "custom", message: "adoption-update-revision-invalid" });
  if (action.kind === "unchanged" && !exact(action.current, action.expectation.current))
    ctx.addIssue({ code: "custom", message: "adoption-unchanged-current-mismatch" });
});
export type SteeringAdoptionAction = DeepReadonly<z.infer<typeof steeringAdoptionActionSchema>>;
export type SteeringAdoptionPublicationAction = Extract<SteeringAdoptionAction, { readonly kind: "create" | "update" }>;

const canonicalExpectationOrder = (values: readonly z.infer<typeof steeringResourceExpectationSchema>[]): boolean =>
  values.every((value, index) => index === 0 || compareText(values[index - 1]!.id, value.id) < 0);
export const steeringAdoptionRegistryObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("absent"),
    project: steeringProjectNamespaceSchema,
  }),
  z.strictObject({
    status: z.literal("present"),
    project: steeringProjectNamespaceSchema,
    head: steeringHeadSchema,
    commit_sequence: commitSequenceSchema,
    steering_generation: steeringGenerationSchema,
    resources: z.array(steeringResourceExpectationSchema).refine(canonicalExpectationOrder,
      "noncanonical-steering-adoption-resource-observation-order"),
  }).superRefine((value, ctx) => {
    if (value.head.project !== value.project || value.head.sequence !== value.commit_sequence ||
      value.head.steering_generation !== value.steering_generation)
      ctx.addIssue({ code: "custom", message: "adoption-registry-head-mismatch" });
  }),
]);
export type SteeringAdoptionRegistryObservation = DeepReadonly<z.infer<typeof steeringAdoptionRegistryObservationSchema>>;

export const steeringAdoptionAuthorizationRequirementSchema = z.strictObject({
  required: z.literal(true),
  contract: z.literal(STEERING_ADOPTION_AUTHORIZATION_SCHEMA),
  actor_kind: z.literal("human"),
  worker_self_modification: z.literal("forbidden"),
});
export const steeringAdoptionOperationRequirementSchema = z.strictObject({
  required: z.literal(true),
  contract: z.literal(STEERING_ADOPTION_OPERATION_CONTRACT),
  storage_idempotency: z.literal("steering-store-operation-id/v1"),
});

const canonicalActionOrder = (values: readonly SteeringAdoptionAction[]): boolean => values.every((value, index) => {
  if (index === 0) return true;
  return compareText(values[index - 1]!.resource, value.resource) < 0;
});
const canonicalActionIds = (values: readonly SteeringAdoptionActionId[]): boolean => values.every((value, index) =>
  index === 0 || compareText(values[index - 1]!, value) < 0);

export const steeringAdoptionPlanSchema = z.strictObject({
  schema: z.literal(STEERING_ADOPTION_PLAN_SCHEMA),
  id: steeringAdoptionPlanIdSchema,
  hash: contentHashSchema,
  project: steeringProjectNamespaceSchema,
  control: z.strictObject({ steering_root: z.literal(STEERING_SOURCE_ROOT) }),
  discovery: z.strictObject({
    policy: z.literal(STEERING_NATIVE_DISCOVERY_POLICY),
    source_schema: z.literal(STEERING_SOURCE_SCHEMA),
    observation_schema: z.literal(STEERING_SOURCE_OBSERVATION_SCHEMA),
  }),
  registry: steeringAdoptionRegistryObservationSchema,
  actions: z.array(steeringAdoptionActionSchema).refine(canonicalActionOrder,
    "noncanonical-steering-adoption-action-order"),
  selection: z.strictObject({
    action_ids: z.array(steeringAdoptionActionIdSchema).refine(canonicalActionIds,
      "noncanonical-steering-adoption-selection-order"),
  }),
  authorization: steeringAdoptionAuthorizationRequirementSchema,
  operation: steeringAdoptionOperationRequirementSchema,
}).superRefine((plan, ctx) => {
  if (plan.registry.project !== plan.project)
    ctx.addIssue({ code: "custom", path: ["registry", "project"], message: "adoption-plan-project-mismatch" });
  const actions = new Map(plan.actions.map((action) => [action.action_id, action]));
  if (new Set(plan.selection.action_ids).size !== plan.selection.action_ids.length)
    ctx.addIssue({ code: "custom", path: ["selection", "action_ids"], message: "adoption-plan-selection-duplicate" });
  for (const actionId of plan.selection.action_ids) {
    const action = actions.get(actionId);
    if (action === undefined || action.kind === "conflict")
      ctx.addIssue({ code: "custom", path: ["selection", "action_ids"], message: "adoption-plan-selection-invalid" });
  }
  for (const action of plan.actions) {
    if (action.source.observation.project !== plan.project || action.source.proposal.provenance.kind !== "project" ||
      action.source.proposal.provenance.project !== plan.project)
      ctx.addIssue({ code: "custom", path: ["actions"], message: "adoption-plan-source-project-mismatch" });
  }
});
export type SteeringAdoptionPlan = DeepReadonly<z.infer<typeof steeringAdoptionPlanSchema>>;

export const steeringAdoptionAuthorizationSchema = z.strictObject({
  schema: z.literal(STEERING_ADOPTION_AUTHORIZATION_SCHEMA),
  project: steeringProjectNamespaceSchema,
  plan: z.strictObject({ id: steeringAdoptionPlanIdSchema, hash: contentHashSchema }),
  by: humanActorSchema,
  decided_at: timestampSchema,
  channel: channelSchema.optional(),
});
export type SteeringAdoptionAuthorization = DeepReadonly<z.infer<typeof steeringAdoptionAuthorizationSchema>>;

const adoptionHeadStateSchema = z.strictObject({
  head: steeringHeadSchema.nullable(),
  steering_generation: steeringGenerationSchema.nullable(),
});
export const steeringAdoptionResultSchema = z.strictObject({
  schema: z.literal(STEERING_ADOPTION_RESULT_SCHEMA),
  status: z.enum(["committed", "no-op"]),
  plan: z.strictObject({ id: steeringAdoptionPlanIdSchema, hash: contentHashSchema }),
  operation: operationIdSchema,
  committed: z.boolean(),
  replayed: z.boolean(),
  previous: adoptionHeadStateSchema,
  current: adoptionHeadStateSchema,
  created_revisions: z.array(steeringRevisionReferenceSchema),
  updated_revisions: z.array(steeringRevisionReferenceSchema),
  unchanged_resources: z.array(steeringResourceIdSchema),
  retired_resources: z.array(steeringResourceIdSchema),
  authoritative_commit: contentHashSchema.nullable(),
  source_observations: z.array(steeringSourceObservationSchema),
  issues: z.array(steeringAdoptionIssueSchema),
});
export type SteeringAdoptionResult = DeepReadonly<z.infer<typeof steeringAdoptionResultSchema>>;

export type SteeringAdoptionPlanResult =
  | { readonly ok: true; readonly plan: SteeringAdoptionPlan }
  | { readonly ok: false; readonly issues: readonly SteeringAdoptionIssue[] };
export type SteeringAdoptionApplyResult =
  | { readonly ok: true; readonly result: SteeringAdoptionResult }
  | { readonly ok: false; readonly issues: readonly SteeringAdoptionIssue[] };

function semanticFilesystem(observation: { readonly filesystem: { readonly kind: string } }): unknown {
  const filesystem = observation.filesystem as Record<string, unknown>;
  // Exact byte descriptors carry size. Native v1 freshness treats only the
  // opened object kind/device/inode as filesystem replacement identity.
  if (filesystem.kind === "filesystem") return {
    kind: filesystem.kind,
    device: filesystem.device,
    inode: filesystem.inode,
  };
  return { kind: filesystem.kind };
}

/** Diagnostic filesystem timestamps do not change a source's semantic review identity. */
export function steeringAdoptionSourceSemanticObservation(observation: SteeringSourceObservation): unknown {
  return { ...observation, filesystem: semanticFilesystem(observation) };
}

/** Native-source provenance retains diagnostics but does not make their timestamps revision semantics. */
export function steeringAdoptionProvenanceSemantic(provenance: unknown): unknown {
  const value = provenance as { kind?: unknown; native_source?: { filesystem: { kind: string }; [key: string]: unknown } };
  if (value.kind !== "project" || value.native_source === undefined) return provenance;
  return { ...value, native_source: { ...value.native_source, filesystem: semanticFilesystem(value.native_source) } };
}

function semanticActionSource(source: SteeringAdoptionSource): unknown {
  return {
    ...source,
    observation: steeringAdoptionSourceSemanticObservation(source.observation),
    authoritative_provenance: steeringAdoptionProvenanceSemantic(source.authoritative_provenance),
  };
}

export function steeringAdoptionActionSemantic(action: SteeringAdoptionAction): unknown {
  const { action_id: _id, source, ...rest } = action;
  return { ...rest, source: semanticActionSource(source) };
}

export function steeringAdoptionActionId(action: Omit<SteeringAdoptionAction, "action_id"> | SteeringAdoptionAction): SteeringAdoptionActionId {
  const { action_id: _id, ...withoutId } = action as SteeringAdoptionAction;
  const hash = hashCanonical({ contract: "aira.dev/steering-adoption-action/v1", action: steeringAdoptionActionSemantic(withoutId as SteeringAdoptionAction) });
  return steeringAdoptionActionIdSchema.parse(`steering_adoption_action_${hash.slice("sha256:".length)}`);
}

export function steeringAdoptionPlanSemantic(plan: SteeringAdoptionPlan): unknown {
  const { id: _id, hash: _hash, actions, ...rest } = plan;
  return {
    ...rest,
    actions: actions.map((action) => ({ ...action, source: semanticActionSource(action.source) })),
  };
}

export function steeringAdoptionPlanHash(plan: SteeringAdoptionPlan): z.infer<typeof contentHashSchema> {
  return hashCanonical(steeringAdoptionPlanSemantic(plan));
}

export function steeringAdoptionPlanIdFromHash(hash: z.infer<typeof contentHashSchema>): SteeringAdoptionPlanId {
  return steeringAdoptionPlanIdSchema.parse(`steering_adoption_plan_${hash.slice("sha256:".length)}`);
}

export function stableSteeringAdoptionIssues(issues: readonly SteeringAdoptionIssue[]): SteeringAdoptionIssue[] {
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

/** Canonical detachment prevents caller mutation from changing reviewed plan identity. */
export function freezeSteeringAdoption<T>(value: T): DeepReadonly<T> {
  return deepFreeze(JSON.parse(canonicalJSON(value)) as T);
}

export function validateSteeringAdoptionPlan(value: unknown): readonly SteeringAdoptionIssue[] {
  const parsed = steeringAdoptionPlanSchema.safeParse(value);
  if (!parsed.success) return stableSteeringAdoptionIssues([{ code: "adoption-plan-invalid",
    detail: parsed.error.issues[0]?.path.map(String).join(".") || parsed.error.issues[0]?.message }]);
  const plan = parsed.data as SteeringAdoptionPlan;
  const issues: SteeringAdoptionIssue[] = [];
  const expectedHash = steeringAdoptionPlanHash(plan);
  if (plan.hash !== expectedHash || plan.id !== steeringAdoptionPlanIdFromHash(expectedHash))
    issues.push({ code: "adoption-plan-invalid", detail: "semantic-identity-mismatch" });
  for (const action of plan.actions) {
    const expectedActionId = steeringAdoptionActionId(action);
    if (action.action_id !== expectedActionId)
      issues.push({ code: "adoption-plan-invalid", resource: action.resource, action: action.action_id, detail: "action-identity-mismatch" });
  }
  return stableSteeringAdoptionIssues(issues);
}

export interface SteeringAdoptionApplyInput {
  readonly project_root: string;
  readonly store: import("../storage/steering-store").SteeringStore;
  readonly plan: unknown;
  readonly authorization?: unknown;
  readonly operation: OperationId | unknown;
}

export interface SteeringAdoptionPlanInput {
  readonly inspection: import("../steering-source").NativeSteeringInspection;
  readonly registry: import("../storage/steering-types").SteeringStoreSnapshot | null;
  /** Resource IDs resolved to immutable action IDs while the plan is created. */
  readonly selection?: readonly string[];
}

export interface InspectAndPlanSteeringAdoptionInput {
  readonly project_root: string;
  readonly project: string;
  readonly store: import("../storage/steering-store").SteeringStore;
  readonly selection?: readonly string[];
}

export interface SteeringAdoptionRegistryState {
  readonly head: z.infer<typeof steeringHeadSchema> | null;
  readonly steering_generation: SteeringGeneration | null;
}

export interface SteeringAdoptionOperationReference {
  readonly operation: OperationId;
  readonly plan: Readonly<{ id: SteeringAdoptionPlanId; hash: z.infer<typeof contentHashSchema> }>;
}
