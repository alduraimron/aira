import { z } from "zod";
import { canonicalJSON, hashCanonical } from "../canonical-json";
import {
  channelSchema,
  compareText,
  contentHashSchema,
  exact,
  humanActorSchema,
  safeUnsignedSchema,
  timestampSchema,
  type DeepReadonly,
} from "../spec/domain/primitives";
import {
  steeringResourceIdSchema,
  steeringRevisionReferenceSchema,
  type SteeringResourceId,
  type SteeringRevisionReference,
} from "../steering/ids";
import { steeringProjectNamespaceSchema, steeringResourceKindSchema } from "../steering/schema";
import {
  STEERING_SOURCE_MEDIA_TYPE,
  STEERING_SOURCE_OBSERVATION_SCHEMA,
  STEERING_SOURCE_ROOT,
  STEERING_SOURCE_SCHEMA,
  steeringSourceObservationSchema,
  steeringSourcePathSchema,
  steeringSourceProposalSchema,
  type SteeringSourceObservation,
} from "../steering-source";
import { steeringHeadSchema } from "../storage/steering-types";

export const STEERING_MATERIALIZATION_PLAN_SCHEMA = "aira.dev/steering-materialization-plan/v1" as const;
export const STEERING_MATERIALIZATION_RESULT_SCHEMA = "aira.dev/steering-materialization-result/v1" as const;
export const STEERING_MATERIALIZATION_AUTHORIZATION_SCHEMA = "aira.dev/steering-materialization-authorization/v1" as const;
export const STEERING_MATERIALIZATION_RENDERER_CONTRACT = "aira.dev/steering-materialization-renderer/native-source/v1" as const;
export const STEERING_MATERIALIZATION_POLICY = "aira.dev/steering-materialization-policy/v1" as const;
export const STEERING_MATERIALIZATION_FRONTMATTER_ENCODING = "aira.dev/canonical-json/v1-as-yaml-1.2" as const;

export const steeringMaterializationPlanIdSchema = z.string()
  .regex(/^steering_materialization_plan_[a-f0-9]{64}$/, "invalid-steering-materialization-plan-id")
  .brand<"SteeringMaterializationPlanId">();
export const steeringMaterializationActionIdSchema = z.string()
  .regex(/^steering_materialization_action_[a-f0-9]{64}$/, "invalid-steering-materialization-action-id")
  .brand<"SteeringMaterializationActionId">();

export type SteeringMaterializationPlanId = z.infer<typeof steeringMaterializationPlanIdSchema>;
export type SteeringMaterializationActionId = z.infer<typeof steeringMaterializationActionIdSchema>;

export const steeringMaterializationIssueCodes = [
  "materialization-plan-invalid",
  "materialization-authority-stale",
  "materialization-target-stale",
  "materialization-target-conflict",
  "materialization-target-collision",
  "materialization-path-unsafe",
  "materialization-replacement-unauthorized",
  "materialization-worker-unauthorized",
  "materialization-render-invalid",
  "materialization-roundtrip-mismatch",
  "materialization-partial",
] as const;
export type SteeringMaterializationIssueCode = typeof steeringMaterializationIssueCodes[number];

export const materializationTargetPathSchema = steeringSourcePathSchema;

function validMaterializationDirectoryPath(value: string): boolean {
  if (value === ".aira" || value === STEERING_SOURCE_ROOT) return true;
  if (!value.startsWith(`${STEERING_SOURCE_ROOT}/`) || value.includes("\\") || value.includes(":")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part));
}

export const materializationDirectoryPathSchema = z.string().min(1).max(1_024)
  .refine(validMaterializationDirectoryPath, "invalid-steering-materialization-directory-path");

const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-materialization-filesystem-decimal");
const positiveLinksSchema = safeUnsignedSchema.refine((value) => value > 0, "invalid-materialization-link-count");

export const materializationSourceDescriptorSchema = z.strictObject({
  hash: contentHashSchema,
  bytes: safeUnsignedSchema,
  media_type: z.literal(STEERING_SOURCE_MEDIA_TYPE),
});
export type MaterializationSourceDescriptor = DeepReadonly<z.infer<typeof materializationSourceDescriptorSchema>>;

export const materializationFileIdentitySchema = z.strictObject({
  device: decimalSchema,
  inode: decimalSchema,
  links: positiveLinksSchema,
  mode: safeUnsignedSchema,
});
export type MaterializationFileIdentity = DeepReadonly<z.infer<typeof materializationFileIdentitySchema>>;

export const materializationDirectoryObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    path: materializationDirectoryPathSchema,
    status: z.literal("absent"),
  }),
  z.strictObject({
    path: materializationDirectoryPathSchema,
    status: z.literal("present"),
    filesystem: materializationFileIdentitySchema,
  }),
]);
export type MaterializationDirectoryObservation = DeepReadonly<z.infer<typeof materializationDirectoryObservationSchema>>;

export const materializationTargetStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("absent"),
    target_path: materializationTargetPathSchema,
  }),
  z.strictObject({
    status: z.literal("present"),
    target_path: materializationTargetPathSchema,
    file: z.strictObject({
      source: materializationSourceDescriptorSchema,
      filesystem: materializationFileIdentitySchema,
      /** Present only when the existing complete source parses under 05C-4A1. */
      proposal: steeringSourceProposalSchema.optional(),
    }),
  }),
]);
export type MaterializationTargetState = DeepReadonly<z.infer<typeof materializationTargetStateSchema>>;

export const steeringMaterializationIssueSchema = z.strictObject({
  code: z.enum(steeringMaterializationIssueCodes),
  resource: steeringResourceIdSchema.optional(),
  action: steeringMaterializationActionIdSchema.optional(),
  /** May name a file target or one of its bound safe parent directories. */
  target_path: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  detail: z.string().optional(),
});
export type SteeringMaterializationIssue = DeepReadonly<z.infer<typeof steeringMaterializationIssueSchema>>;

export const steeringMaterializationAuthorityResourceSchema = z.strictObject({
  id: steeringResourceIdSchema,
  revision: steeringRevisionReferenceSchema,
  body: materializationSourceDescriptorSchema,
  kind: steeringResourceKindSchema,
  custom_kind: z.string().optional(),
  authorable_semantics_hash: contentHashSchema,
}).superRefine((value, ctx) => {
  if (value.revision.id !== value.id || value.revision.hash !== value.body.hash)
    ctx.addIssue({ code: "custom", message: "materialization-authority-resource-reference-mismatch" });
  if ((value.kind === "custom") !== (value.custom_kind !== undefined))
    ctx.addIssue({ code: "custom", message: "materialization-authority-custom-kind-mismatch" });
});
export type SteeringMaterializationAuthorityResource = DeepReadonly<z.infer<typeof steeringMaterializationAuthorityResourceSchema>>;

const canonicalAuthorityResources = (values: readonly SteeringMaterializationAuthorityResource[]): boolean => values.every((value, index) =>
  index === 0 || compareText(values[index - 1]!.id, value.id) < 0);

export const steeringMaterializationAuthoritySchema = z.strictObject({
  project: steeringProjectNamespaceSchema,
  head: steeringHeadSchema,
  commit_sequence: z.string().regex(/^[1-9][0-9]*$/, "invalid-materialization-commit-sequence"),
  steering_generation: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-materialization-steering-generation"),
  resources: z.array(steeringMaterializationAuthorityResourceSchema).refine(canonicalAuthorityResources,
    "noncanonical-materialization-authority-resource-order"),
}).superRefine((value, ctx) => {
  if (value.head.project !== value.project || value.head.sequence !== value.commit_sequence ||
    value.head.steering_generation !== value.steering_generation)
    ctx.addIssue({ code: "custom", message: "materialization-authority-head-mismatch" });
});
export type SteeringMaterializationAuthority = DeepReadonly<z.infer<typeof steeringMaterializationAuthoritySchema>>;

const actionBase = {
  action_id: steeringMaterializationActionIdSchema,
  resource: steeringResourceIdSchema,
  authority: steeringMaterializationAuthorityResourceSchema,
  target_path: materializationTargetPathSchema,
  target: materializationTargetStateSchema,
  rendered: materializationSourceDescriptorSchema,
};

export const steeringMaterializationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...actionBase, kind: z.literal("create") }),
  z.strictObject({ ...actionBase, kind: z.literal("unchanged") }),
  z.strictObject({ ...actionBase, kind: z.literal("replace") }),
  z.strictObject({ ...actionBase, kind: z.literal("conflict"), issues: z.array(steeringMaterializationIssueSchema).min(1) }),
]).superRefine((value, ctx) => {
  if (value.resource !== value.authority.id || value.target_path !== value.target.target_path)
    ctx.addIssue({ code: "custom", message: "materialization-action-reference-mismatch" });
  if ((value.kind === "create") !== (value.target.status === "absent"))
    ctx.addIssue({ code: "custom", message: "materialization-action-target-state-mismatch" });
  if ((value.kind === "unchanged" || value.kind === "replace" || value.kind === "conflict") && value.target.status !== "present")
    ctx.addIssue({ code: "custom", message: "materialization-action-target-state-mismatch" });
});
export type SteeringMaterializationAction = DeepReadonly<z.infer<typeof steeringMaterializationActionSchema>>;
export type SteeringMaterializationWriteAction = Extract<SteeringMaterializationAction, { readonly kind: "create" | "replace" }>;

const canonicalActionOrder = (values: readonly SteeringMaterializationAction[]): boolean => values.every((value, index) => {
  if (index === 0) return true;
  const previous = values[index - 1]!;
  return compareText(previous.target_path, value.target_path) < 0 ||
    (previous.target_path === value.target_path && compareText(previous.resource, value.resource) < 0);
});
const canonicalDirectoryOrder = (values: readonly string[]): boolean => values.every((value, index) =>
  index === 0 || compareText(values[index - 1]!, value) < 0);

export const steeringMaterializationAuthorizationRequirementSchema = z.discriminatedUnion("replacement", [
  z.strictObject({
    replacement: z.literal("not-required"),
    required: z.literal(false),
  }),
  z.strictObject({
    replacement: z.literal("required"),
    required: z.literal(true),
    contract: z.literal(STEERING_MATERIALIZATION_AUTHORIZATION_SCHEMA),
    actor_kind: z.literal("human"),
    worker_self_modification: z.literal("forbidden"),
  }),
]);
export type SteeringMaterializationAuthorizationRequirement = DeepReadonly<z.infer<typeof steeringMaterializationAuthorizationRequirementSchema>>;

export const steeringMaterializationPlanSchema = z.strictObject({
  schema: z.literal(STEERING_MATERIALIZATION_PLAN_SCHEMA),
  id: steeringMaterializationPlanIdSchema,
  hash: contentHashSchema,
  project: steeringProjectNamespaceSchema,
  control: z.strictObject({ authoring_root: z.literal(STEERING_SOURCE_ROOT) }),
  renderer: z.strictObject({
    contract: z.literal(STEERING_MATERIALIZATION_RENDERER_CONTRACT),
    source_schema: z.literal(STEERING_SOURCE_SCHEMA),
    source_observation_schema: z.literal(STEERING_SOURCE_OBSERVATION_SCHEMA),
    frontmatter_encoding: z.literal(STEERING_MATERIALIZATION_FRONTMATTER_ENCODING),
  }),
  policy: z.strictObject({
    contract: z.literal(STEERING_MATERIALIZATION_POLICY),
    existing_file_policy: z.literal("preserve-unless-exact-replace"),
    publication: z.literal("durable-atomic-per-file/v1"),
    multi_file_atomicity: z.literal("none"),
  }),
  authority: steeringMaterializationAuthoritySchema,
  directories: z.array(materializationDirectoryObservationSchema)
    .refine((values) => canonicalDirectoryOrder(values.map((value) => value.path)), "noncanonical-materialization-directory-order"),
  create_directories: z.array(materializationDirectoryPathSchema).refine(canonicalDirectoryOrder,
    "noncanonical-materialization-create-directory-order"),
  actions: z.array(steeringMaterializationActionSchema).refine(canonicalActionOrder,
    "noncanonical-materialization-action-order"),
  authorization: steeringMaterializationAuthorizationRequirementSchema,
}).superRefine((plan, ctx) => {
  if (plan.authority.project !== plan.project)
    ctx.addIssue({ code: "custom", path: ["authority", "project"], message: "materialization-plan-project-mismatch" });
  const resources = new Map(plan.authority.resources.map((resource) => [resource.id, resource]));
  if (resources.size !== plan.authority.resources.length)
    ctx.addIssue({ code: "custom", path: ["authority", "resources"], message: "materialization-plan-authority-resource-duplicate" });
  const actionResources = new Set<string>(), actionTargets = new Set<string>();
  for (const action of plan.actions) {
    if (!resources.has(action.resource) || !exact(resources.get(action.resource), action.authority))
      ctx.addIssue({ code: "custom", path: ["actions"], message: "materialization-action-authority-mismatch" });
    if (actionResources.has(action.resource) || actionTargets.has(action.target_path))
      ctx.addIssue({ code: "custom", path: ["actions"], message: "materialization-action-duplicate" });
    actionResources.add(action.resource); actionTargets.add(action.target_path);
    const sourceParts = action.target_path.slice(`${STEERING_SOURCE_ROOT}/`.length).split("/");
    if (action.target_path.split("/").at(-1) === ["AGENTS", "md"].join(".") ||
      (sourceParts[0] === "custom" && sourceParts.length - 2 > 4) ||
      (sourceParts[0] !== "custom" && sourceParts.length !== 1))
      ctx.addIssue({ code: "custom", path: ["actions"], message: "materialization-target-path-policy" });
    if (action.authority.kind === "custom" && !action.target_path.startsWith(`${STEERING_SOURCE_ROOT}/custom/`))
      ctx.addIssue({ code: "custom", path: ["actions"], message: "materialization-custom-target-outside-custom-root" });
  }
  if (actionResources.size !== resources.size)
    ctx.addIssue({ code: "custom", path: ["actions"], message: "materialization-plan-action-resource-coverage" });
  const absent = plan.directories.filter((directory) => directory.status === "absent").map((directory) => directory.path);
  if (!exact(absent, plan.create_directories))
    ctx.addIssue({ code: "custom", path: ["create_directories"], message: "materialization-directory-creation-mismatch" });
  const needsReplacement = plan.actions.some((action) => action.kind === "replace");
  if (needsReplacement !== (plan.authorization.replacement === "required"))
    ctx.addIssue({ code: "custom", path: ["authorization"], message: "materialization-replacement-authorization-mismatch" });
});
export type SteeringMaterializationPlan = DeepReadonly<z.infer<typeof steeringMaterializationPlanSchema>>;

export const steeringMaterializationAuthorizationSchema = z.strictObject({
  schema: z.literal(STEERING_MATERIALIZATION_AUTHORIZATION_SCHEMA),
  project: steeringProjectNamespaceSchema,
  plan: z.strictObject({ id: steeringMaterializationPlanIdSchema, hash: contentHashSchema }),
  by: humanActorSchema,
  decided_at: timestampSchema,
  channel: channelSchema.optional(),
});
export type SteeringMaterializationAuthorization = DeepReadonly<z.infer<typeof steeringMaterializationAuthorizationSchema>>;

export const steeringMaterializationFileSchema = z.strictObject({
  resource: steeringResourceIdSchema,
  revision: steeringRevisionReferenceSchema,
  target_path: materializationTargetPathSchema,
  observation: steeringSourceObservationSchema,
}).superRefine((value, ctx) => {
  if (value.resource !== value.revision.id || value.target_path !== value.observation.source_path ||
    value.resource !== value.observation.identity.id)
    ctx.addIssue({ code: "custom", message: "materialization-result-file-mismatch" });
});
export type SteeringMaterializationFile = DeepReadonly<z.infer<typeof steeringMaterializationFileSchema>>;

export const steeringMaterializationResultSchema = z.strictObject({
  schema: z.literal(STEERING_MATERIALIZATION_RESULT_SCHEMA),
  status: z.enum(["complete", "partial", "no-op", "failed-before-write"]),
  plan: z.strictObject({ id: steeringMaterializationPlanIdSchema, hash: contentHashSchema }),
  authority: z.strictObject({
    head: steeringHeadSchema,
    steering_generation: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-materialization-result-generation"),
  }),
  resource_revisions: z.array(steeringRevisionReferenceSchema),
  created_files: z.array(steeringMaterializationFileSchema),
  replaced_files: z.array(steeringMaterializationFileSchema),
  unchanged_files: z.array(steeringMaterializationFileSchema),
  conflicts: z.array(steeringMaterializationIssueSchema),
  partial_applied_files: z.array(steeringMaterializationFileSchema),
  target_source_observations: z.array(steeringMaterializationFileSchema),
  diagnostics: z.array(steeringMaterializationIssueSchema),
});
export type SteeringMaterializationResult = DeepReadonly<z.infer<typeof steeringMaterializationResultSchema>>;

export type SteeringMaterializationPlanResult =
  | { readonly ok: true; readonly plan: SteeringMaterializationPlan }
  | { readonly ok: false; readonly issues: readonly SteeringMaterializationIssue[] };
export type SteeringMaterializationApplyResult =
  | { readonly ok: true; readonly result: SteeringMaterializationResult }
  | { readonly ok: false; readonly result?: SteeringMaterializationResult; readonly issues: readonly SteeringMaterializationIssue[] };

export const steeringMaterializationFailpoints = [
  "after-temp-write",
  "after-temp-fsync",
  "before-target-publication",
  "after-target-publication",
  "before-directory-fsync",
  "after-directory-fsync",
] as const;
export type SteeringMaterializationFailpoint = typeof steeringMaterializationFailpoints[number];

export interface SteeringMaterializationFileOptions {
  readonly token?: () => string;
  readonly failpoint?: (point: SteeringMaterializationFailpoint) => void | Promise<void>;
}

export interface SteeringMaterializationPlanInput {
  readonly project_root: string;
  readonly project: string;
  readonly store: import("../storage/steering-store").SteeringStore;
  readonly blobs: import("../storage/blob-store").BlobStore;
  /** Defaults to every active current authoritative resource. */
  readonly resources?: readonly string[];
  /** Compatibility spelling for explicit resource selection. */
  readonly resource_ids?: readonly string[];
  /** Maps a logical resource ID to its explicit native authoring target. */
  readonly targets?: Readonly<Record<string, string>>;
  /** Compatibility spelling for explicit target selection. */
  readonly target_paths?: Readonly<Record<string, string>>;
  /** Exact logical resources whose existing source bytes may be replaced. */
  readonly replace?: readonly string[];
  /** Compatibility spelling for exact destructive replacement selection. */
  readonly replacement_resources?: readonly string[];
}

export interface SteeringMaterializationApplyInput {
  readonly project_root: string;
  readonly store: import("../storage/steering-store").SteeringStore;
  readonly blobs: import("../storage/blob-store").BlobStore;
  readonly plan: unknown;
  readonly authorization?: unknown;
  readonly file_options?: SteeringMaterializationFileOptions;
}

export function materializationPortablePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function stableSteeringMaterializationIssues(issues: readonly SteeringMaterializationIssue[]): SteeringMaterializationIssue[] {
  return [...new Map(issues.map((issue) => [canonicalJSON(issue), issue])).values()]
    .sort((left, right) => compareText(canonicalJSON(left), canonicalJSON(right)));
}

export function steeringMaterializationActionSemantic(action: SteeringMaterializationAction): unknown {
  const { action_id: _id, ...semantic } = action;
  return semantic;
}

export function steeringMaterializationActionId(
  action: Omit<SteeringMaterializationAction, "action_id"> | SteeringMaterializationAction,
): SteeringMaterializationActionId {
  const { action_id: _id, ...withoutId } = action as SteeringMaterializationAction;
  const hash = hashCanonical({ contract: "aira.dev/steering-materialization-action/v1", action: steeringMaterializationActionSemantic(withoutId as SteeringMaterializationAction) });
  return steeringMaterializationActionIdSchema.parse(`steering_materialization_action_${hash.slice("sha256:".length)}`);
}

export function steeringMaterializationPlanSemantic(plan: SteeringMaterializationPlan): unknown {
  const { id: _id, hash: _hash, actions, ...rest } = plan;
  return { ...rest, actions: actions.map((action) => steeringMaterializationActionSemantic(action)) };
}

export function steeringMaterializationPlanHash(plan: SteeringMaterializationPlan): z.infer<typeof contentHashSchema> {
  return hashCanonical(steeringMaterializationPlanSemantic(plan));
}

export function steeringMaterializationPlanIdFromHash(hash: z.infer<typeof contentHashSchema>): SteeringMaterializationPlanId {
  return steeringMaterializationPlanIdSchema.parse(`steering_materialization_plan_${hash.slice("sha256:".length)}`);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Canonical detachment makes plans immutable and independent of caller object identity. */
export function freezeSteeringMaterialization<T>(value: T): DeepReadonly<T> {
  return deepFreeze(JSON.parse(canonicalJSON(value)) as T);
}

export function validateSteeringMaterializationPlan(value: unknown): readonly SteeringMaterializationIssue[] {
  const parsed = steeringMaterializationPlanSchema.safeParse(value);
  if (!parsed.success) return stableSteeringMaterializationIssues([{
    code: "materialization-plan-invalid",
    detail: parsed.error.issues[0]?.path.map(String).join(".") || parsed.error.issues[0]?.message,
  }]);
  const plan = parsed.data as SteeringMaterializationPlan;
  const issues: SteeringMaterializationIssue[] = [];
  const hash = steeringMaterializationPlanHash(plan);
  if (plan.hash !== hash || plan.id !== steeringMaterializationPlanIdFromHash(hash))
    issues.push({ code: "materialization-plan-invalid", detail: "semantic-identity-mismatch" });
  for (const action of plan.actions) if (action.action_id !== steeringMaterializationActionId(action))
    issues.push({ code: "materialization-plan-invalid", resource: action.resource, action: action.action_id,
      target_path: action.target_path, detail: "action-identity-mismatch" });
  const portable = new Map<string, string>();
  for (const action of plan.actions) {
    const key = materializationPortablePathKey(action.target_path);
    const prior = portable.get(key);
    if (prior !== undefined && prior !== action.target_path)
      issues.push({ code: "materialization-target-collision", target_path: action.target_path,
        related_paths: [prior, action.target_path].sort(compareText), detail: "portable-path-ambiguity" });
    portable.set(key, action.target_path);
  }
  return stableSteeringMaterializationIssues(issues);
}

export function materializationAuthorityResourceFor(
  authority: SteeringMaterializationAuthority,
  resource: SteeringResourceId,
): SteeringMaterializationAuthorityResource | undefined {
  return authority.resources.find((candidate) => candidate.id === resource);
}

export function materializationRevisionReferences(actions: readonly SteeringMaterializationAction[]): SteeringRevisionReference[] {
  return actions.map((action) => action.authority.revision)
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.revision, right.revision));
}

export type MaterializationTargetSourceObservation = SteeringSourceObservation;
