import { z } from "zod";
import { hashCanonical } from "../canonical-json";
import { exactPathSchema } from "../context/declarations";
import { contentHashSchema, createdMetadataSchema, safeUnsignedSchema, compareText, type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import { controlProjectIdSchema, projectIdentitySchema, repositoryIdentitySchema, sourceObservationIdSchema } from "./ids";
import { workspaceProviderDescriptorSchema } from "./provider";
import { checked, required } from "./domain";

const gitCommitSchema = z.strictObject({
  kind: z.literal("git"), repository: repositoryIdentitySchema, object_format: z.enum(["sha1", "sha256"]),
  commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
}).refine((base) => base.commit.length === (base.object_format === "sha1" ? 40 : 64), "workspace-source-invalid");
const snapshotBaseSchema = z.strictObject({
  kind: z.literal("snapshot"), manifest_hash: contentHashSchema, bytes_hash: contentHashSchema,
  byte_count: safeUnsignedSchema, retained_reference: contentHashSchema,
  captured_tree_hash: contentHashSchema,
});
export const baseRevisionSchema = z.union([gitCommitSchema, snapshotBaseSchema]);
const unmaterializedSchema = z.strictObject({
  kind: z.literal("unmaterialized"), reason: z.enum(["non-git-tree", "unborn-head"]), tree_hash: contentHashSchema,
});
export const sourceBaseSchema = z.union([gitCommitSchema, snapshotBaseSchema, unmaterializedSchema]);
export const dirtyPolicySchema = z.enum(["require-clean", "base-only", "include-observed-overlay"]);
export const sourceOverlaySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("observed"), manifest_hash: contentHashSchema,
    staged: contentHashSchema, tracked: contentHashSchema, untracked: contentHashSchema, ignored: contentHashSchema,
    exclusions: z.array(exactPathSchema.max(4096)).max(1024),
  }).refine((o) => new Set(o.exclusions).size === o.exclusions.length, "workspace-source-invalid"),
]);
const gitHeadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("attached") }),
  z.strictObject({ kind: z.literal("detached") }),
  z.strictObject({ kind: z.literal("unborn") }),
]);
const gitSourceSchema = z.strictObject({
  kind: z.literal("git"), repository: repositoryIdentitySchema,
  base: z.union([gitCommitSchema, unmaterializedSchema]),
  head: gitHeadSchema, worktree: z.strictObject({ kind: z.enum(["main", "linked"]), identity: contentHashSchema }),
  state: z.enum(["normal", "bare", "unmerged-index", "sparse", "partial", "nested-repository", "submodules", "unknown"]),
  submodule_policy: z.strictObject({ schema: z.literal("aira.dev/workspace-submodules/reject/v1"),
    observations: z.array(z.strictObject({ path: exactPathSchema.max(4096), gitlink: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) })).max(10000) }),
}).superRefine((s, ctx) => {
  if (s.base.kind === "git" && (s.base.repository !== s.repository || s.head.kind === "unborn") ||
    s.base.kind === "unmaterialized" && (s.base.reason !== "unborn-head" || s.head.kind !== "unborn") ||
    new Set(s.submodule_policy.observations.map((o) => o.path)).size !== s.submodule_policy.observations.length)
    ctx.addIssue({ code: "custom", message: "workspace-source-invalid" });
});
const snapshotSourceSchema = z.strictObject({
  kind: z.literal("snapshot"), base: z.union([snapshotBaseSchema, unmaterializedSchema]),
  observed_tree: contentHashSchema,
}).refine((s) => s.base.kind !== "unmaterialized" ||
  s.base.reason === "non-git-tree" && s.base.tree_hash === s.observed_tree, "workspace-source-invalid");
export const sourceObservationSubjectSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-source-observation-subject/v1"),
  control_project: controlProjectIdSchema, project: projectIdentitySchema,
  registered_root_association: contentHashSchema,
  provider: workspaceProviderDescriptorSchema,
  inspection_policy: z.strictObject({ schema: z.literal("aira.dev/workspace-source-inspection/v1"), hash: contentHashSchema }),
  source: z.discriminatedUnion("kind", [gitSourceSchema, snapshotSourceSchema]),
  overlay: sourceOverlaySchema, dirty_state: z.enum(["clean", "dirty", "unknown"]),
  consistency: z.enum(["stable", "unknown"]),
}).superRefine((s, ctx) => {
  if ((s.dirty_state === "clean" && s.overlay.kind !== "none") || (s.dirty_state === "dirty" && s.overlay.kind !== "observed") ||
      (s.consistency === "stable" && s.dirty_state === "unknown") ||
      (s.source.kind === "git" && s.source.submodule_policy.observations.length && s.source.state !== "submodules") ||
      (s.source.kind === "snapshot" && s.source.base.kind === "snapshot" && s.overlay.kind === "none" &&
        s.source.base.captured_tree_hash !== s.source.observed_tree))
    ctx.addIssue({ code: "custom", message: "workspace-source-invalid" });
});
export const sourceObservationSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-source-observation/v1"), id: sourceObservationIdSchema,
  subject: sourceObservationSubjectSchema, audit: createdMetadataSchema,
  diagnostics: z.strictObject({ git_branch: z.string().min(1).max(1024).optional() }).optional(),
}).superRefine((o, ctx) => {
  if (o.id !== `source_observation_${hashCanonical(o.subject).slice(7)}`)
    ctx.addIssue({ code: "custom", path: ["id"], message: "workspace-source-observation-mismatch" });
  if (o.diagnostics?.git_branch && (o.subject.source.kind !== "git" || o.subject.source.head.kind === "detached"))
    ctx.addIssue({ code: "custom", message: "workspace-source-invalid" });
  const source = o.subject.source;
  const exclusions = o.subject.overlay.kind === "observed" ? o.subject.overlay.exclusions : [];
  if (source.kind === "git" && source.submodule_policy.observations.some((entry, i) => i > 0 &&
      compareText(source.submodule_policy.observations[i - 1]!.path, entry.path) >= 0) ||
      exclusions.some((path, i) => i > 0 && compareText(exclusions[i - 1]!, path) >= 0))
    ctx.addIssue({ code: "custom", message: "workspace-source-invalid" });
});
export type BaseRevision = DeepReadonly<z.infer<typeof baseRevisionSchema>>;
export type SourceObservation = DeepReadonly<z.infer<typeof sourceObservationSchema>>;
export type DirtyPolicy = z.infer<typeof dirtyPolicySchema>;
export type SourceObservationSubject = DeepReadonly<z.infer<typeof sourceObservationSubjectSchema>>;

export function createSourceObservation(input: { subject: DeepReadonly<z.input<typeof sourceObservationSubjectSchema>>;
  audit: DeepReadonly<z.input<typeof createdMetadataSchema>>; diagnostics?: { readonly git_branch?: string } }): SourceObservation {
  const subject = required(checked(sourceObservationSubjectSchema, input.subject, "workspace-source-invalid"));
  const source = subject.source.kind === "git" ? {
    ...subject.source, submodule_policy: { ...subject.source.submodule_policy,
      observations: [...subject.source.submodule_policy.observations].sort((a, b) => compareText(a.path, b.path)) },
  } : subject.source;
  const normalized = { ...subject, source, overlay: subject.overlay.kind === "observed" ?
    { ...subject.overlay, exclusions: [...subject.overlay.exclusions].sort(compareText) } : subject.overlay };
  return required(checked(sourceObservationSchema, { schema: "aira.dev/workspace-source-observation/v1",
    id: `source_observation_${hashCanonical(normalized).slice(7)}`, subject: normalized, audit: input.audit,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}) }, "workspace-source-invalid"));
}
/** Pure contradictions that a provider must reject before attempting preparation. */
export function sourceDecisionIssues(observation: SourceObservation, policy: DirtyPolicy, topology: string): DomainIssue[] {
  const { source, dirty_state, overlay, consistency } = observation.subject;
  const issues: DomainIssue[] = [];
  if (consistency !== "stable" || dirty_state === "unknown" || source.base.kind === "unmaterialized" ||
      source.kind === "git" && (source.state !== "normal" || source.submodule_policy.observations.length !== 0))
    issues.push({ code: "workspace-source-invalid" });
  if (policy === "require-clean" && (overlay.kind !== "none" || dirty_state !== "clean") ||
      policy === "include-observed-overlay" && (overlay.kind !== "observed" || dirty_state !== "dirty") ||
      policy === "base-only" && topology === "in-place" && overlay.kind !== "none")
    issues.push({ code: "workspace-dirty-policy-invalid" });
  return issues;
}
