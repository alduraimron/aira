import { z } from "zod";
import { behavioralAssetReferenceSchema } from "../builtins/assets";
import {
  blobReferenceSchema,
  canonical,
  compareText,
  contentHashSchema,
  createdMetadataSchema,
  exact,
  nonBlankSchema,
  profileReferenceSchema,
  safeUnsignedSchema,
} from "../spec/domain/primitives";
import { steeringInclusionSchema, steeringScopeSchema } from "./applicability";
import {
  authorityEffectIssues,
  authorityEnforcementIssues,
  steeringAuthoritySchema,
  steeringEnforcementBindingsSchema,
  steeringOverridePolicySchema,
  steeringRuleEffectSchema,
  versionedContractSchema,
} from "./authority";
import {
  steeringCustomCategorySchema,
  steeringResourceIdSchema,
  steeringRevisionIdSchema,
  steeringRevisionReferenceSchema,
  steeringRuleIdSchema,
  steeringSemanticKeySchema,
  type SteeringRevisionReference,
} from "./ids";

export const standardSteeringResourceKinds = [
  "product",
  "architecture",
  "technology",
  "structure",
  "engineering",
  "testing",
  "security",
  "operations",
] as const;
export const steeringResourceKindSchema = z.enum([...standardSteeringResourceKinds, "custom"]);

export const steeringProjectNamespaceSchema = z.string().max(63)
  .regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "invalid-steering-project-namespace");

const sourceIdentitySchema = z.string().max(500)
  .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "invalid-steering-source-identity");

export const steeringSourceReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("steering-revision"),
    revision: steeringRevisionReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("agents-md"),
    source_identity: sourceIdentitySchema,
    source_revision: nonBlankSchema.optional(),
    hash: contentHashSchema,
    adapter: profileReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("imported"),
    contract: versionedContractSchema,
    source_identity: sourceIdentitySchema,
    source_revision: nonBlankSchema,
    hash: contentHashSchema,
  }),
]);

const steeringNativeSourceContentSchema = z.strictObject({
  hash: contentHashSchema,
  bytes: safeUnsignedSchema,
  media_type: z.literal("text/markdown; charset=utf-8"),
});
const steeringNativeSourceFilesystemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("filesystem"),
    device: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-native-source-device"),
    inode: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-native-source-inode"),
    links: safeUnsignedSchema.refine((value) => value > 0, "invalid-native-source-links"),
    mode: safeUnsignedSchema,
    size: safeUnsignedSchema,
    modified_ns: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-native-source-time"),
    changed_ns: z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-native-source-time"),
  }),
  z.strictObject({ kind: z.literal("detached"), size: safeUnsignedSchema }),
]);
const steeringNativeSourcePathSchema = z.string().min(1).max(1_024)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes(":") &&
    !/[\u0000-\u001f\u007f]/.test(value) && value.endsWith(".md") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "invalid-native-source-path");
const steeringNativeSourceProvenanceSchema = z.strictObject({
  kind: z.literal("native-project-source"),
  project: steeringProjectNamespaceSchema,
  authorship: z.enum(["authored", "adopted"]),
  adopted_from: steeringSourceReferenceSchema.optional(),
}).refine((value) => (value.authorship === "adopted") === (value.adopted_from !== undefined),
  "invalid-native-source-adoption");

/**
 * Immutable attribution carried by an authoritative project revision after a
 * native authoring source is explicitly adopted. It is source provenance, not
 * a second resource or a materialization pointer.
 */
export const steeringNativeSourceAttributionSchema = z.strictObject({
  schema: z.literal("aira.dev/steering-source-observation/v1"),
  source_schema: z.literal("aira.dev/steering-source/v1"),
  discovery: z.literal("aira.dev/steering-discovery/native/v1"),
  project: steeringProjectNamespaceSchema,
  // Adapters validate their own materialization root; pure provenance stores it as data.
  control: z.strictObject({ steering_root: sourceIdentitySchema }),
  source_path: steeringNativeSourcePathSchema,
  identity: z.strictObject({
    id: steeringResourceIdSchema,
    kind: steeringResourceKindSchema,
    custom_kind: steeringCustomCategorySchema.optional(),
  }),
  source: steeringNativeSourceContentSchema,
  body: steeringNativeSourceContentSchema,
  metadata_hash: contentHashSchema,
  filesystem: steeringNativeSourceFilesystemSchema,
  provenance: steeringNativeSourceProvenanceSchema,
}).superRefine((value, ctx) => {
  if (value.source.bytes !== value.filesystem.size)
    ctx.addIssue({ code: "custom", path: ["filesystem", "size"], message: "native-source-size-mismatch" });
  if (value.body.bytes > value.source.bytes)
    ctx.addIssue({ code: "custom", path: ["body", "bytes"], message: "native-source-body-size-invalid" });
  if ((value.identity.kind === "custom") !== (value.identity.custom_kind !== undefined))
    ctx.addIssue({ code: "custom", path: ["identity", "custom_kind"], message: "invalid-steering-custom-kind" });
  if (!/^(?:steering|project\.steering)\./.test(value.identity.id))
    ctx.addIssue({ code: "custom", path: ["identity", "id"], message: "native-source-project-identity-required" });
  if (value.provenance.project !== value.project)
    ctx.addIssue({ code: "custom", path: ["provenance", "project"], message: "native-source-project-mismatch" });
});

export const steeringProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("project"),
    project: steeringProjectNamespaceSchema,
    authorship: z.enum(["authored", "adopted"]),
    adopted_from: steeringSourceReferenceSchema.optional(),
    native_source: steeringNativeSourceAttributionSchema.optional(),
  }).superRefine((value, ctx) => {
    if ((value.authorship === "adopted") !== (value.adopted_from !== undefined))
      ctx.addIssue({ code: "custom", message: "invalid-project-steering-adoption" });
    if (value.native_source !== undefined && (value.native_source.project !== value.project ||
      value.native_source.provenance.authorship !== value.authorship ||
      !exact(value.native_source.provenance.adopted_from, value.adopted_from)))
      ctx.addIssue({ code: "custom", message: "invalid-project-native-source-attribution" });
  }),
  z.strictObject({
    kind: z.literal("aira-template"),
    publisher: z.literal("aira"),
    published_content_hash: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal("interoperability"),
    source: steeringSourceReferenceSchema.refine((source) => source.kind === "agents-md", "invalid-interoperability-source"),
  }),
  z.strictObject({
    kind: z.literal("imported"),
    source: steeringSourceReferenceSchema.refine((source) => source.kind === "imported", "invalid-imported-source"),
    importer: profileReferenceSchema,
    transformation: z.enum(["exact", "transformed"]),
  }),
]);

export const steeringLayerSchema = z.enum([
  "template",
  "project-root",
  "project-scoped",
  "interoperability",
  "imported",
]);

const canonicalArray = (values: readonly unknown[]): boolean => values.every((value, index) =>
  index === 0 || compareText(canonical(values[index - 1]), canonical(value)) < 0);

export const steeringRuleSourceSchema = z.strictObject({
  content_hash: contentHashSchema,
  location: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("document") }),
    z.strictObject({ kind: z.literal("heading"), heading: nonBlankSchema }),
    z.strictObject({ kind: z.literal("anchor"), anchor: z.string().regex(/^[a-z][a-z0-9-]*$/, "invalid-steering-source-anchor") }),
    z.strictObject({
      kind: z.literal("line-range"),
      start: safeUnsignedSchema.refine((value) => value > 0, "invalid-steering-line-start"),
      end: safeUnsignedSchema.refine((value) => value > 0, "invalid-steering-line-end"),
    }).refine((value) => value.end >= value.start, "invalid-steering-line-range"),
  ]),
});

export const steeringRuleSemanticsSchema = z.strictObject({
  key: steeringSemanticKeySchema,
  effect: steeringRuleEffectSchema,
  value: z.json(),
});

export const steeringRuleSchema = z.strictObject({
  id: steeringRuleIdSchema,
  title: nonBlankSchema,
  authority: steeringAuthoritySchema,
  semantics: steeringRuleSemanticsSchema,
  override_policy: steeringOverridePolicySchema,
  status: z.enum(["active", "deprecated"]),
  scope: steeringScopeSchema.optional(),
  inclusion: steeringInclusionSchema.optional(),
  rationale: nonBlankSchema.optional(),
  enforcement: steeringEnforcementBindingsSchema,
  source: steeringRuleSourceSchema.optional(),
}).superRefine((rule, ctx) => {
  for (const issue of authorityEnforcementIssues(rule.authority, rule.enforcement, rule.id))
    ctx.addIssue({ code: "custom", message: issue.code });
  for (const issue of authorityEffectIssues(rule.authority, rule.semantics.effect, rule.id))
    ctx.addIssue({ code: "custom", message: issue.code });
  if (rule.authority === "enforceable" && rule.override_policy === "explicit-replacement")
    ctx.addIssue({ code: "custom", message: "enforceable-steering-explicit-replacement-forbidden" });
});

export const steeringOverrideSchema = z.strictObject({
  target: z.strictObject({
    resource: steeringRevisionReferenceSchema,
    rule: steeringRuleIdSchema.optional(),
  }),
  mode: z.enum(["specialize", "strengthen", "replace"]),
  rationale: nonBlankSchema,
});

export const steeringCompositionSchema = z.strictObject({
  parents: z.array(steeringRevisionReferenceSchema)
    .refine(canonicalArray, "noncanonical-steering-parent-order"),
  overrides: z.array(steeringOverrideSchema)
    .refine(canonicalArray, "noncanonical-steering-override-order"),
}).superRefine((value, ctx) => {
  const parents = value.parents.map((parent) => `${parent.id}@${parent.revision}`);
  if (new Set(parents).size !== parents.length)
    ctx.addIssue({ code: "custom", message: "duplicate-steering-parent" });
  const targets = value.overrides.map((override) =>
    `${override.target.resource.id}@${override.target.resource.revision}:${override.target.rule ?? "*"}`);
  if (new Set(targets).size !== targets.length)
    ctx.addIssue({ code: "custom", message: "duplicate-steering-override-target" });
});

export const steeringCompatibilitySchema = z.strictObject({
  resolver: z.literal("aira.dev/steering-resolution/v1"),
  required_schemas: z.array(versionedContractSchema)
    .refine((values) => values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) < 0),
      "noncanonical-steering-required-schemas"),
});

export const steeringResourceRevisionSchema = z.strictObject({
  schema: z.literal("aira.dev/steering-resource/v1"),
  identity: steeringRevisionReferenceSchema,
  kind: steeringResourceKindSchema,
  custom_kind: steeringCustomCategorySchema.optional(),
  layer: steeringLayerSchema,
  provenance: steeringProvenanceSchema,
  content: blobReferenceSchema,
  content_encoding: z.literal("aira.dev/steering-bytes/raw/v1"),
  default_authority: steeringAuthoritySchema,
  default_override_policy: steeringOverridePolicySchema,
  default_enforcement: steeringEnforcementBindingsSchema,
  inclusion: steeringInclusionSchema,
  scope: steeringScopeSchema,
  rules: z.array(steeringRuleSchema),
  composition: steeringCompositionSchema,
  compatibility: steeringCompatibilitySchema,
  metadata: z.strictObject({
    title: nonBlankSchema,
    description: nonBlankSchema.optional(),
    labels: z.array(nonBlankSchema)
      .refine((values) => values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) < 0),
        "noncanonical-steering-labels"),
  }),
  created: createdMetadataSchema,
  behavioral_assets: z.array(behavioralAssetReferenceSchema)
    .refine(canonicalArray, "noncanonical-steering-behavioral-attribution"),
  supersedes: steeringRevisionReferenceSchema.optional(),
}).superRefine((resource, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: "custom", message });
  if ((resource.kind === "custom") !== (resource.custom_kind !== undefined)) issue("invalid-steering-custom-kind");
  if (resource.identity.hash !== resource.content.hash) issue("steering-content-identity-mismatch");

  const standardName = resource.identity.id.replace(/^(?:project\.|template\.|interop\.|imported\.)?steering\./, "");
  if (standardSteeringResourceKinds.includes(standardName as typeof standardSteeringResourceKinds[number]) &&
    resource.kind !== standardName) issue("steering-standard-resource-kind-mismatch");

  const namespace = resource.identity.id;
  const layerMatches = resource.provenance.kind === "project" ?
    (namespace.startsWith("steering.") || namespace.startsWith("project.steering.")) &&
      (resource.layer === "project-root" || resource.layer === "project-scoped") :
    resource.provenance.kind === "aira-template" ? namespace.startsWith("template.steering.") && resource.layer === "template" :
    resource.provenance.kind === "interoperability" ? namespace.startsWith("interop.steering.") && resource.layer === "interoperability" :
    namespace.startsWith("imported.steering.") && resource.layer === "imported";
  if (!layerMatches) issue("steering-provenance-namespace-layer-mismatch");

  if (resource.provenance.kind === "aira-template" &&
    resource.provenance.published_content_hash !== resource.identity.hash) issue("steering-template-content-hash-mismatch");
  if (resource.provenance.kind === "interoperability" &&
    resource.provenance.source.hash !== resource.identity.hash) issue("steering-interoperability-content-hash-mismatch");
  if (resource.provenance.kind === "imported" && resource.provenance.transformation === "exact" &&
    resource.provenance.source.hash !== resource.identity.hash) issue("steering-imported-exact-content-hash-mismatch");

  for (const domainIssue of authorityEnforcementIssues(resource.default_authority, resource.default_enforcement, resource.identity.id))
    issue(domainIssue.code);
  if (resource.default_authority === "enforceable" && resource.default_override_policy === "explicit-replacement")
    issue("enforceable-steering-explicit-replacement-forbidden");

  if (resource.rules.some((rule, index) => index > 0 && compareText(resource.rules[index - 1]!.id, rule.id) >= 0))
    issue("noncanonical-steering-rule-order");
  if (resource.rules.some((rule) => rule.source !== undefined && rule.source.content_hash !== resource.identity.hash))
    issue("steering-rule-source-hash-mismatch");

  const behaviorKeys = resource.behavioral_assets.map((asset) => `${asset.id}@${asset.revision}`);
  if (new Set(behaviorKeys).size !== behaviorKeys.length) issue("duplicate-steering-behavioral-attribution");
  if ((resource.created.by.kind === "model" || resource.created.by.kind === "worker") &&
    resource.behavioral_assets.length === 0) issue("generated-steering-behavioral-attribution-required");

  if (resource.layer === "project-scoped" && resource.scope.kind === "project-global")
    issue("project-scoped-steering-requires-narrow-scope");
  if (resource.composition.parents.some((parent) => parent.id === resource.identity.id))
    issue("steering-resource-cannot-inherit-own-lineage");
  if (resource.composition.overrides.some((override) =>
    override.target.resource.id === resource.identity.id && override.target.resource.revision === resource.identity.revision))
    issue("steering-resource-cannot-override-self");

  if (resource.supersedes !== undefined && (resource.supersedes.id !== resource.identity.id ||
    !steeringRevisionIdSchema.safeParse(resource.supersedes.revision).success ||
    !steeringRevisionIdSchema.safeParse(resource.identity.revision).success ||
    BigInt(resource.supersedes.revision) >= BigInt(resource.identity.revision))) issue("invalid-steering-predecessor");
});

export type SteeringResourceKindValue = z.infer<typeof steeringResourceKindSchema>;
export type SteeringRuleValue = z.infer<typeof steeringRuleSchema>;
export type SteeringProvenanceValue = z.infer<typeof steeringProvenanceSchema>;
export type SteeringSourceReferenceValue = z.infer<typeof steeringSourceReferenceSchema>;
export type SteeringOverrideValue = z.infer<typeof steeringOverrideSchema>;
export type SteeringResourceRevisionValue = z.infer<typeof steeringResourceRevisionSchema>;

export function sourceReferenceForRevision(revision: SteeringRevisionReference): SteeringSourceReferenceValue {
  return { kind: "steering-revision", revision };
}
