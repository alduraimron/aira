import { z } from "zod";
import { behavioralAssetReferenceSchema } from "../builtins/assets";
import { contentHashSchema, safeUnsignedSchema, type ContentHash, type DeepReadonly } from "../spec/domain/primitives";
import {
  steeringInclusionSchema,
  steeringScopeSchema,
} from "../steering/applicability";
import {
  authorityEnforcementIssues,
  steeringAuthoritySchema,
  steeringEnforcementBindingsSchema,
  steeringOverridePolicySchema,
} from "../steering/authority";
import {
  steeringCustomCategorySchema,
  steeringResourceIdSchema,
  steeringRuleIdSchema,
} from "../steering/ids";
import {
  steeringCompatibilitySchema,
  steeringCompositionSchema,
  steeringProjectNamespaceSchema,
  steeringProvenanceSchema,
  steeringResourceKindSchema,
  steeringRuleSchema,
  steeringRuleSemanticsSchema,
  steeringRuleSourceSchema,
  steeringSourceReferenceSchema,
} from "../steering/schema";
import type {
  SteeringCompatibility,
  SteeringComposition,
  SteeringEnforcementBinding,
  SteeringInclusion,
  SteeringLayer,
  SteeringProvenance,
  SteeringResourceKind,
  SteeringRule,
  SteeringScope,
} from "../steering/types";
import type { SteeringResourceId } from "../steering/ids";

export const STEERING_SOURCE_SCHEMA = "aira.dev/steering-source/v1" as const;
export const STEERING_SOURCE_OBSERVATION_SCHEMA = "aira.dev/steering-source-observation/v1" as const;
export const STEERING_SOURCE_FILE_OBSERVATION_SCHEMA = "aira.dev/steering-source-file-observation/v1" as const;
export const STEERING_SOURCE_PROPOSAL_SCHEMA = "aira.dev/steering-source-proposal/v1" as const;
export const STEERING_NATIVE_INSPECTION_SCHEMA = "aira.dev/steering-native-inspection/v1" as const;
export const STEERING_NATIVE_DISCOVERY_POLICY = "aira.dev/steering-discovery/native/v1" as const;
export const STEERING_SOURCE_CONTENT_ENCODING = "aira.dev/steering-bytes/raw/v1" as const;
export const STEERING_SOURCE_MEDIA_TYPE = "text/markdown; charset=utf-8" as const;
export const STEERING_SOURCE_ROOT = ".aira/steering" as const;

/** Fixed limits are part of the native discovery policy, not caller tuning knobs. */
export const nativeSteeringDiscoveryPolicy = Object.freeze({
  contract: STEERING_NATIVE_DISCOVERY_POLICY,
  source_root: STEERING_SOURCE_ROOT,
  extensions: Object.freeze([".md"] as const),
  custom_directory: "custom" as const,
  custom_max_depth: 4,
  max_files: 256,
  max_file_bytes: 1_048_576,
  max_aggregate_bytes: 8_388_608,
  max_rules_per_resource: 256,
  max_frontmatter_bytes: 262_144,
  max_metadata_depth: 48,
  max_metadata_nodes: 100_000,
  max_entries_per_directory: 1_024,
  max_total_entries: 4_096,
  max_logical_path_bytes: 1_024,
  ordering: "resource-id-then-source-path-codepoint" as const,
});

const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-decimal-observation");
const positiveLinksSchema = safeUnsignedSchema.refine((value) => value > 0, "invalid-link-count");

export const steeringSourceFilesystemObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("filesystem"),
    device: decimalSchema,
    inode: decimalSchema,
    links: positiveLinksSchema,
    mode: safeUnsignedSchema,
    size: safeUnsignedSchema,
    modified_ns: decimalSchema,
    changed_ns: decimalSchema,
  }),
  z.strictObject({
    kind: z.literal("detached"),
    size: safeUnsignedSchema,
  }),
]);

export const steeringSourcePathSchema = z.string()
  .min(1)
  .max(nativeSteeringDiscoveryPolicy.max_logical_path_bytes)
  .refine((value) => new TextEncoder().encode(value).length <= nativeSteeringDiscoveryPolicy.max_logical_path_bytes,
    "steering-source-path-size-limit")
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes(":"), "invalid-steering-source-path")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "invalid-steering-source-path")
  .refine((value) => value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "invalid-steering-source-path")
  .refine((value) => value.startsWith(`${STEERING_SOURCE_ROOT}/`), "invalid-steering-source-root")
  .refine((value) => value.endsWith(".md"), "unsupported-steering-source-extension");

const sourceRuleLocationSchema = steeringRuleSourceSchema.shape.location;
export const steeringSourceRuleSchema = z.strictObject({
  id: steeringRuleIdSchema,
  title: steeringRuleSchema.shape.title,
  authority: steeringRuleSchema.shape.authority,
  semantics: steeringRuleSemanticsSchema,
  override_policy: steeringRuleSchema.shape.override_policy,
  status: steeringRuleSchema.shape.status,
  scope: steeringScopeSchema.optional(),
  inclusion: steeringInclusionSchema.optional(),
  rationale: steeringRuleSchema.shape.rationale,
  enforcement: steeringEnforcementBindingsSchema,
  /** The body hash is adapter-derived and therefore cannot be self-declared. */
  source: z.strictObject({ location: sourceRuleLocationSchema }).optional(),
});

export const steeringSourceProvenanceDeclarationSchema = z.discriminatedUnion("authorship", [
  z.strictObject({ authorship: z.literal("authored") }),
  z.strictObject({
    authorship: z.literal("adopted"),
    adopted_from: steeringSourceReferenceSchema,
  }),
]);

/**
 * Native frontmatter intentionally mirrors the existing Steering resource and
 * rule value objects. Publication-owned revision, predecessor, creation, and
 * project fields are absent and are not guessed by this adapter.
 */
export const steeringSourceMetadataSchema = z.strictObject({
  schema: z.literal(STEERING_SOURCE_SCHEMA),
  id: steeringResourceIdSchema,
  kind: steeringResourceKindSchema,
  custom_kind: steeringCustomCategorySchema.optional(),
  layer: z.enum(["project-root", "project-scoped"]),
  provenance: steeringSourceProvenanceDeclarationSchema,
  authority: steeringAuthoritySchema,
  override_policy: steeringOverridePolicySchema,
  enforcement: steeringEnforcementBindingsSchema,
  inclusion: steeringInclusionSchema,
  scope: steeringScopeSchema,
  rules: z.array(steeringSourceRuleSchema).max(nativeSteeringDiscoveryPolicy.max_rules_per_resource),
  composition: steeringCompositionSchema,
  compatibility: steeringCompatibilitySchema,
  title: steeringRuleSchema.shape.title,
  description: steeringRuleSchema.shape.rationale,
  labels: z.array(steeringRuleSchema.shape.title),
  behavioral_assets: z.array(behavioralAssetReferenceSchema),
});

export const steeringSourceFrontmatterSchema = z.strictObject({
  aira: steeringSourceMetadataSchema,
});

const exactContentSchema = z.strictObject({
  hash: contentHashSchema,
  bytes: safeUnsignedSchema,
  media_type: z.literal(STEERING_SOURCE_MEDIA_TYPE),
});

export const steeringSourceFileObservationSchema = z.strictObject({
  schema: z.literal(STEERING_SOURCE_FILE_OBSERVATION_SCHEMA),
  discovery: z.literal(STEERING_NATIVE_DISCOVERY_POLICY),
  project: steeringProjectNamespaceSchema,
  source_path: steeringSourcePathSchema,
  source: exactContentSchema,
  filesystem: steeringSourceFilesystemObservationSchema,
}).superRefine((value, ctx) => {
  if (value.source.bytes !== value.filesystem.size)
    ctx.addIssue({ code: "custom", path: ["filesystem", "size"], message: "steering-source-observed-size-mismatch" });
});

export const steeringNativeSourceProvenanceSchema = z.strictObject({
  kind: z.literal("native-project-source"),
  project: steeringProjectNamespaceSchema,
  authorship: z.enum(["authored", "adopted"]),
  adopted_from: steeringSourceReferenceSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.authorship === "adopted") !== (value.adopted_from !== undefined))
    ctx.addIssue({ code: "custom", message: "invalid-native-source-adoption" });
});

export const steeringSourceObservationSchema = z.strictObject({
  schema: z.literal(STEERING_SOURCE_OBSERVATION_SCHEMA),
  source_schema: z.literal(STEERING_SOURCE_SCHEMA),
  discovery: z.literal(STEERING_NATIVE_DISCOVERY_POLICY),
  project: steeringProjectNamespaceSchema,
  control: z.strictObject({ steering_root: z.literal(STEERING_SOURCE_ROOT) }),
  source_path: steeringSourcePathSchema,
  identity: z.strictObject({
    id: steeringResourceIdSchema,
    kind: steeringResourceKindSchema,
    custom_kind: steeringCustomCategorySchema.optional(),
  }),
  source: exactContentSchema,
  body: exactContentSchema,
  metadata_hash: contentHashSchema,
  filesystem: steeringSourceFilesystemObservationSchema,
  provenance: steeringNativeSourceProvenanceSchema,
}).superRefine((value, ctx) => {
  if (value.source.bytes !== value.filesystem.size)
    ctx.addIssue({ code: "custom", path: ["filesystem", "size"], message: "steering-source-observed-size-mismatch" });
  if (value.body.bytes > value.source.bytes)
    ctx.addIssue({ code: "custom", path: ["body", "bytes"], message: "steering-source-body-size-invalid" });
  if ((value.identity.kind === "custom") !== (value.identity.custom_kind !== undefined))
    ctx.addIssue({ code: "custom", path: ["identity", "custom_kind"], message: "invalid-steering-custom-kind" });
  if (!/^(?:steering|project\.steering)\./.test(value.identity.id))
    ctx.addIssue({ code: "custom", path: ["identity", "id"], message: "steering-source-project-identity-required" });
  if (value.provenance.project !== value.project)
    ctx.addIssue({ code: "custom", path: ["provenance", "project"], message: "steering-source-project-mismatch" });
});

export const steeringSourceProposalSchema = z.strictObject({
  schema: z.literal(STEERING_SOURCE_PROPOSAL_SCHEMA),
  identity: z.strictObject({
    id: steeringResourceIdSchema,
    body_hash: contentHashSchema,
  }),
  kind: steeringResourceKindSchema,
  custom_kind: steeringCustomCategorySchema.optional(),
  layer: z.enum(["project-root", "project-scoped"]),
  provenance: steeringProvenanceSchema,
  content: exactContentSchema,
  content_encoding: z.literal(STEERING_SOURCE_CONTENT_ENCODING),
  default_authority: steeringAuthoritySchema,
  default_override_policy: steeringOverridePolicySchema,
  default_enforcement: steeringEnforcementBindingsSchema,
  inclusion: steeringInclusionSchema,
  scope: steeringScopeSchema,
  rules: z.array(steeringRuleSchema).max(nativeSteeringDiscoveryPolicy.max_rules_per_resource),
  composition: steeringCompositionSchema,
  compatibility: steeringCompatibilitySchema,
  metadata: z.strictObject({
    title: steeringRuleSchema.shape.title,
    description: steeringRuleSchema.shape.rationale,
    labels: z.array(steeringRuleSchema.shape.title),
  }),
  behavioral_assets: z.array(behavioralAssetReferenceSchema),
  source_metadata_hash: contentHashSchema,
}).superRefine((value, ctx) => {
  const issue = (path: PropertyKey[], message: string): void => ctx.addIssue({ code: "custom", path, message });
  if (value.identity.body_hash !== value.content.hash)
    issue(["identity", "body_hash"], "steering-source-body-identity-mismatch");
  if ((value.kind === "custom") !== (value.custom_kind !== undefined))
    issue(["custom_kind"], "invalid-steering-custom-kind");
  if (value.provenance.kind !== "project")
    issue(["provenance"], "steering-source-project-provenance-required");
  if (!/^(?:steering|project\.steering)\./.test(value.identity.id) ||
    value.layer !== "project-root" && value.layer !== "project-scoped")
    issue(["identity", "id"], "steering-source-project-identity-required");
  const standardName = value.identity.id.replace(/^(?:project\.)?steering\./, "");
  if (["product", "architecture", "technology", "structure", "engineering", "testing", "security", "operations"].includes(standardName) &&
    value.kind !== standardName) issue(["kind"], "steering-standard-resource-kind-mismatch");
  for (const bindingIssue of authorityEnforcementIssues(value.default_authority, value.default_enforcement, value.identity.id))
    issue(["default_enforcement"], bindingIssue.code);
  if (value.default_authority === "enforceable" && value.default_override_policy === "explicit-replacement")
    issue(["default_override_policy"], "enforceable-steering-explicit-replacement-forbidden");
  if (value.rules.some((rule) => rule.source !== undefined && rule.source.content_hash !== value.content.hash))
    issue(["rules"], "steering-rule-source-hash-mismatch");
});

export const steeringSourceIssueCodes = [
  "steering-source-input-invalid",
  "steering-source-project-invalid",
  "steering-source-path-invalid",
  "steering-source-root-missing",
  "steering-source-root-unsafe",
  "steering-source-symlink",
  "steering-source-hardlink",
  "steering-source-non-regular",
  "steering-source-path-race",
  "steering-source-unreadable",
  "steering-source-entry-limit",
  "steering-source-file-count-limit",
  "steering-source-file-size-limit",
  "steering-source-aggregate-size-limit",
  "steering-source-custom-depth-limit",
  "steering-source-unsupported-extension",
  "steering-source-unsupported-directory",
  "steering-source-encoding-invalid",
  "steering-source-binary-content",
  "steering-source-framing-invalid",
  "steering-source-frontmatter-size-limit",
  "steering-source-yaml-invalid",
  "steering-source-yaml-feature-forbidden",
  "steering-source-schema-unsupported",
  "steering-source-unknown-field",
  "steering-source-metadata-limit",
  "steering-source-metadata-invalid",
  "steering-source-kind-invalid",
  "steering-source-provenance-invalid",
  "steering-source-authority-invalid",
  "steering-source-rule-invalid",
  "steering-source-rule-count-limit",
  "steering-source-rule-location-invalid",
  "steering-source-conventional-name-mismatch",
  "steering-source-duplicate-resource-id",
] as const;
export type SteeringSourceIssueCode = typeof steeringSourceIssueCodes[number];

export interface SteeringSourceIssue {
  readonly code: SteeringSourceIssueCode;
  readonly severity: "error" | "warning";
  readonly path?: string;
  readonly resource_id?: SteeringResourceId;
  readonly related_paths?: readonly string[];
  readonly field?: string;
  /** Stable machine-readable detail, not user-facing prose. */
  readonly detail?: string;
}

export type SteeringSourceFilesystemObservation = DeepReadonly<z.infer<typeof steeringSourceFilesystemObservationSchema>>;
export type SteeringSourceMetadata = DeepReadonly<z.infer<typeof steeringSourceMetadataSchema>>;
export type SteeringSourceFileObservation = DeepReadonly<z.infer<typeof steeringSourceFileObservationSchema>>;
export type SteeringSourceObservation = DeepReadonly<z.infer<typeof steeringSourceObservationSchema>>;
export type SteeringSourceProposal = DeepReadonly<z.infer<typeof steeringSourceProposalSchema>>;

export interface ParseNativeSteeringSourceInput {
  readonly project: string;
  readonly source_path: string;
  readonly bytes: Uint8Array;
  readonly filesystem?: SteeringSourceFilesystemObservation;
}

export interface SteeringSourceParseSuccess {
  readonly ok: true;
  readonly observation: SteeringSourceObservation;
  readonly proposal: SteeringSourceProposal;
  /** Exact complete authoring bytes. Callers must recheck against observation.source before adoption. */
  readonly source_bytes: Uint8Array;
  /** Exact bytes after the closing frontmatter delimiter and its terminator. */
  readonly body_bytes: Uint8Array;
  readonly warnings: readonly SteeringSourceIssue[];
}

export interface SteeringSourceParseFailure {
  readonly ok: false;
  readonly source_path: string;
  readonly file?: SteeringSourceFileObservation;
  readonly issues: readonly SteeringSourceIssue[];
  readonly warnings: readonly SteeringSourceIssue[];
}

export type SteeringSourceParseResult = SteeringSourceParseSuccess | SteeringSourceParseFailure;

export interface SteeringDuplicateSourceIdentity {
  readonly resource_id: SteeringResourceId;
  readonly paths: readonly string[];
  readonly issue: SteeringSourceIssue;
}

export interface SteeringInvalidNativeSource {
  readonly source_path: string;
  readonly file?: SteeringSourceFileObservation;
  readonly issues: readonly SteeringSourceIssue[];
  /** Present when a source parsed in isolation but was invalidated by an inspection-level conflict. */
  readonly parsed?: SteeringSourceParseSuccess;
}

export interface NativeSteeringInspection {
  readonly schema: typeof STEERING_NATIVE_INSPECTION_SCHEMA;
  readonly status: "valid" | "invalid";
  readonly complete: boolean;
  readonly root_status: "present" | "missing" | "unsafe" | "unreadable";
  readonly discovery_policy: typeof nativeSteeringDiscoveryPolicy;
  readonly project: string;
  readonly control: Readonly<{ steering_root: typeof STEERING_SOURCE_ROOT }>;
  readonly discovered_sources: readonly SteeringSourceFileObservation[];
  /** Unambiguous, individually valid proposals. Adoption must also require inspection status `valid`. */
  readonly proposals: readonly SteeringSourceParseSuccess[];
  readonly invalid_sources: readonly SteeringInvalidNativeSource[];
  readonly duplicate_identities: readonly SteeringDuplicateSourceIdentity[];
  readonly unsafe_paths: readonly SteeringSourceIssue[];
  readonly warnings: readonly SteeringSourceIssue[];
}

export interface InspectNativeSteeringOptions {
  readonly project: string;
}

export const conventionalSteeringSourceIds = Object.freeze({
  "product.md": "steering.product",
  "architecture.md": "steering.architecture",
  "technology.md": "steering.technology",
  "structure.md": "steering.structure",
  "engineering.md": "steering.engineering",
  "testing.md": "steering.testing",
  "security.md": "steering.security",
  "operations.md": "steering.operations",
} as const);

export interface SteeringSourceObservationComparison {
  readonly status: "match" | "stale" | "invalid";
  readonly reasons: readonly SteeringSourceObservationChangeReason[];
}

export const steeringSourceObservationChangeReasons = [
  "source-observation-invalid",
  "discovery-policy-changed",
  "source-schema-changed",
  "project-changed",
  "source-path-changed",
  "source-bytes-changed",
  "body-bytes-changed",
  "metadata-changed",
  "parsed-identity-changed",
  "provenance-changed",
  "source-replaced",
] as const;
export type SteeringSourceObservationChangeReason = typeof steeringSourceObservationChangeReasons[number];

/** Publication-owned fields intentionally absent from SteeringSourceProposal. */
export type SteeringSourceProposalDomainView = Readonly<{
  id: SteeringResourceId;
  kind: SteeringResourceKind;
  custom_kind?: string;
  layer: Extract<SteeringLayer, "project-root" | "project-scoped">;
  provenance: SteeringProvenance;
  content: Readonly<{ hash: ContentHash; bytes: number; media_type: typeof STEERING_SOURCE_MEDIA_TYPE }>;
  default_authority: z.infer<typeof steeringAuthoritySchema>;
  default_override_policy: z.infer<typeof steeringOverridePolicySchema>;
  default_enforcement: readonly SteeringEnforcementBinding[];
  inclusion: SteeringInclusion;
  scope: SteeringScope;
  rules: readonly SteeringRule[];
  composition: SteeringComposition;
  compatibility: SteeringCompatibility;
}>;
