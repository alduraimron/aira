import { z } from "zod";
import { hashCanonical } from "../canonical-json";
import { exactPathSchema } from "../context/declarations";
import { contentHashSchema, compareText, createdMetadataSchema, safeUnsignedSchema, exact, stableIssues,
  type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import type { WorkspaceHandleV2 } from "./handle";
import { workspaceIdSchema, controlProjectIdSchema, projectIdentitySchema, repositoryIdentitySchema,
  workspaceIncarnationSchema, workspaceFingerprintIdSchema, sourceObservationIdSchema } from "./ids";
import { workspaceProviderDescriptorSchema } from "./provider";
import { baseRevisionSchema } from "./source";
import { checked, required, WorkspaceDomainError } from "./domain";

const exclusionSchema = z.strictObject({ path: exactPathSchema.max(4096), reason: z.enum(["control-state", "git-metadata"]),
  scope: z.literal("both-roots") });
const captureConfigSchema = z.strictObject({
  algorithm: z.literal("aira.dev/workspace-fingerprint-algorithm/sha256-canonical-json/v1"),
  coverage: z.strictObject({ tracked_worktree: z.literal("included"), index: z.literal("stage-0-only"),
    untracked: z.literal("included"), ignored: z.literal("included"), symlinks: z.literal("link-target-bytes"),
    empty_directories: z.literal("included"), submodules: z.literal("reject"), nested_repositories: z.literal("reject") }),
  exclusions: z.array(exclusionSchema).length(2),
  additional_exclusions: z.array(z.strictObject({ path: exactPathSchema.max(4096),
    reason: z.literal("declared-provider-cache"), affected_consumers: z.array(z.string().min(1).max(128)).min(1).max(16),
  })).max(32),
});
const defaultConfig = {
  algorithm: "aira.dev/workspace-fingerprint-algorithm/sha256-canonical-json/v1",
  coverage: { tracked_worktree: "included", index: "stage-0-only", untracked: "included", ignored: "included",
    symlinks: "link-target-bytes", empty_directories: "included", submodules: "reject", nested_repositories: "reject" },
  // Exact top-level path subtrees; .aira authoring surfaces are control inputs under v1.
  exclusions: [{ path: ".aira", reason: "control-state", scope: "both-roots" },
    { path: ".git", reason: "git-metadata", scope: "both-roots" }],
  additional_exclusions: [],
} as const;
export const workspaceFingerprintPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-capture/all-project-content/v1"),
  configuration: captureConfigSchema, hash: contentHashSchema,
}).superRefine((p, ctx) => {
  if (p.hash !== hashCanonical({ schema: p.schema, configuration: p.configuration }) ||
      p.configuration.exclusions.length !== 2 || p.configuration.exclusions[0]?.path !== ".aira" ||
      p.configuration.exclusions[1]?.path !== ".git" ||
      p.configuration.exclusions[0]?.reason !== "control-state" || p.configuration.exclusions[1]?.reason !== "git-metadata" ||
      new Set(p.configuration.additional_exclusions.map((e) => e.path.normalize("NFC").toLowerCase().normalize("NFC"))).size !==
        p.configuration.additional_exclusions.length ||
      p.configuration.additional_exclusions.some((e) => [".git", ".aira"].some((control) => {
        const path = e.path.normalize("NFC").toLowerCase().normalize("NFC");
        return path === control || path.startsWith(`${control}/`) || control.startsWith(`${path}/`);
      }) ||
        new Set(e.affected_consumers).size !== e.affected_consumers.length ||
        e.affected_consumers.some((consumer, i) => i > 0 && compareText(e.affected_consumers[i - 1]!, consumer) >= 0)) ||
      p.configuration.additional_exclusions.some((e, i) => i > 0 && compareText(p.configuration.additional_exclusions[i - 1]!.path, e.path) >= 0) ||
      p.configuration.additional_exclusions.some((e, i) => p.configuration.additional_exclusions.some((other, j) =>
        i !== j && e.path.normalize("NFC").toLowerCase().normalize("NFC").startsWith(
          `${other.path.normalize("NFC").toLowerCase().normalize("NFC")}/`))))
    ctx.addIssue({ code: "custom", message: "workspace-fingerprint-policy-mismatch" });
});
export type WorkspaceFingerprintPolicy = DeepReadonly<z.infer<typeof workspaceFingerprintPolicySchema>>;
export function createWorkspaceFingerprintPolicy(configuration: DeepReadonly<z.input<typeof captureConfigSchema>>): WorkspaceFingerprintPolicy {
  const parsed = required(checked(captureConfigSchema, configuration, "workspace-fingerprint-policy-mismatch"));
  const normalized = { ...parsed, exclusions: [...parsed.exclusions].sort((a, b) => compareText(a.path, b.path)),
    additional_exclusions: parsed.additional_exclusions.map((exclusion) => ({ ...exclusion,
      affected_consumers: [...exclusion.affected_consumers].sort(compareText) })).sort((a, b) => compareText(a.path, b.path)) };
  const subject = { schema: "aira.dev/workspace-capture/all-project-content/v1", configuration: normalized };
  return required(checked(workspaceFingerprintPolicySchema, { ...subject, hash: hashCanonical(subject) },
    "workspace-fingerprint-policy-mismatch"));
}
export function defaultWorkspaceFingerprintPolicy(): WorkspaceFingerprintPolicy {
  return createWorkspaceFingerprintPolicy(defaultConfig);
}

// These are semantic identities of bytes, not file contents. No inode/mtime/status shortcuts.
const regularSchema = z.strictObject({ kind: z.literal("regular"), hash: contentHashSchema,
  bytes: safeUnsignedSchema, executable: z.boolean() });
const symlinkSchema = z.strictObject({ kind: z.literal("symlink"), target_hash: contentHashSchema,
  target_bytes: safeUnsignedSchema });
const deletedSchema = z.strictObject({ kind: z.literal("deleted") });
const emptyDirectorySchema = z.strictObject({ kind: z.literal("empty-directory") });
// Reserved representational shape. v1 capture policy rejects nested repositories/submodules.
const nestedRepositorySchema = z.strictObject({ kind: z.literal("nested-repository"), repository: repositoryIdentitySchema,
  gitlink_commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), observation_hash: contentHashSchema });
export const workspacePathStateSchema = z.discriminatedUnion("kind", [regularSchema, symlinkSchema, deletedSchema,
  emptyDirectorySchema, nestedRepositorySchema]);
export const workspaceManifestEntrySchema = z.strictObject({
  path: exactPathSchema.max(4096),
  worktree: z.strictObject({ category: z.enum(["tracked", "untracked", "ignored"]), state: workspacePathStateSchema }),
  index: z.strictObject({ stage: z.literal(0), state: z.union([regularSchema, symlinkSchema, deletedSchema, nestedRepositorySchema]) }).optional(),
}).superRefine((e, ctx) => {
  if (e.index && e.worktree.category !== "tracked" ||
      e.worktree.category !== "tracked" && e.worktree.state.kind === "deleted" ||
      e.worktree.state.kind === "nested-repository" || e.index?.state.kind === "nested-repository" ||
      [".git", ".aira"].includes(e.path.split("/")[0]!.toLowerCase()))
    ctx.addIssue({ code: "custom", message: "workspace-manifest-path-invalid" });
});
export type WorkspaceManifestEntry = DeepReadonly<z.infer<typeof workspaceManifestEntrySchema>>;
const manifestSubject = (entries: readonly WorkspaceManifestEntry[]) => ({ schema: "aira.dev/workspace-path-manifest/v1", entries });
export const workspacePathManifestSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-path-manifest/v1"), hash: contentHashSchema,
  entries: z.array(workspaceManifestEntrySchema).max(250000),
}).superRefine((m, ctx) => {
  const paths = new Set<string>(), aliases = new Set<string>();
  for (const [i, entry] of m.entries.entries()) {
    if (paths.has(entry.path)) ctx.addIssue({ code: "custom", path: ["entries", i, "path"], message: "workspace-manifest-duplicate-path" });
    // Reject known ambiguous Unicode/case spellings; do not silently normalize either spelling.
    const alias = entry.path.normalize("NFC").toLowerCase().normalize("NFC");
    if (aliases.has(alias) && !paths.has(entry.path)) ctx.addIssue({ code: "custom", path: ["entries", i, "path"], message: "workspace-manifest-duplicate-path" });
    paths.add(entry.path);
    aliases.add(alias);
    if (i && compareText(m.entries[i - 1]!.path, entry.path) >= 0)
      ctx.addIssue({ code: "custom", path: ["entries", i, "path"], message: "workspace-manifest-order-invalid" });
  }
  for (const entry of m.entries) {
    const segments = entry.path.split("/");
    for (let i = 1; i < segments.length; i++) if (paths.has(segments.slice(0, i).join("/")))
      ctx.addIssue({ code: "custom", path: ["entries"], message: "workspace-manifest-path-invalid" });
  }
  if (m.hash !== hashCanonical(manifestSubject(m.entries))) ctx.addIssue({ code: "custom", path: ["hash"], message: "workspace-fingerprint-invalid" });
});
export type WorkspacePathManifest = DeepReadonly<z.infer<typeof workspacePathManifestSchema>>;

const categorySchema = z.enum(["staged", "tracked", "untracked", "ignored"]);
const stateComponentSchema = z.strictObject({ category: categorySchema, hash: contentHashSchema });
const repositoryComponentSchema = z.strictObject({ kind: z.enum(["git-index", "git-tree"]), hash: contentHashSchema });
export function stateComponents(entries: readonly WorkspaceManifestEntry[]) {
  const categories = ["staged", "tracked", "untracked", "ignored"] as const;
  return categories.map((category) => ({ category, hash: hashCanonical({ schema: "aira.dev/workspace-state-component/v1", category,
    paths: entries.flatMap((entry): { path: string; state: unknown }[] => category === "staged" ?
      entry.index ? [{ path: entry.path, state: entry.index }] : [] :
      entry.worktree.category === category ? [{ path: entry.path, state: entry.worktree.state }] : []),
  }) }));
}
export const workspaceFingerprintSubjectSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-fingerprint-subject/v2"), control_project: controlProjectIdSchema,
  workspace_id: workspaceIdSchema, incarnation: workspaceIncarnationSchema, project: projectIdentitySchema,
  repository: repositoryIdentitySchema.optional(), provider: workspaceProviderDescriptorSchema,
  source_observation: sourceObservationIdSchema, base: baseRevisionSchema,
  policy: workspaceFingerprintPolicySchema, manifest: workspacePathManifestSchema,
  state_components: z.array(stateComponentSchema).length(4),
  repository_components: z.array(repositoryComponentSchema).max(2),
}).superRefine((s, ctx) => {
  const expectedComponents = stateComponents(s.manifest.entries);
  if (s.base.kind === "git" ? s.base.repository !== s.repository ||
      s.repository_components.map((c) => c.kind).join(",") !== "git-index,git-tree" ||
      s.manifest.entries.some((e) => e.worktree.category === "tracked" && !e.index) :
      s.repository !== undefined || s.repository_components.length !== 0 ||
      s.manifest.entries.some((e) => e.index !== undefined))
    ctx.addIssue({ code: "custom", message: "workspace-fingerprint-invalid" });
  if (s.provider.fingerprint_policy_schema !== s.policy.schema ||
      s.manifest.entries.some((entry) => s.policy.configuration.additional_exclusions.some((excluded) => {
        const path = entry.path.normalize("NFC").toLowerCase().normalize("NFC");
        const omitted = excluded.path.normalize("NFC").toLowerCase().normalize("NFC");
        return path === omitted || path.startsWith(`${omitted}/`);
      })) ||
      s.state_components.some((c, i) => c.category !== expectedComponents[i]?.category ||
        c.hash !== expectedComponents[i]?.hash))
    ctx.addIssue({ code: "custom", message: "workspace-fingerprint-policy-mismatch" });
});
export const workspaceFingerprintV2Schema = z.strictObject({
  schema: z.literal("aira.dev/workspace-fingerprint/v2"), id: workspaceFingerprintIdSchema,
  digest: contentHashSchema, subject: workspaceFingerprintSubjectSchema,
  audit: createdMetadataSchema.optional(),
}).superRefine((f, ctx) => {
  const digest = hashCanonical(f.subject);
  if (f.digest !== digest || f.id !== `workspace_fingerprint_${digest.slice(7)}`)
    ctx.addIssue({ code: "custom", message: "workspace-fingerprint-invalid" });
});
export type WorkspaceFingerprintV2 = DeepReadonly<z.infer<typeof workspaceFingerprintV2Schema>>;
export function createWorkspaceFingerprint(input: {
  binding: DeepReadonly<Omit<z.input<typeof workspaceFingerprintSubjectSchema>, "schema" | "manifest" | "state_components" | "repository_components">>;
  entries: readonly DeepReadonly<z.input<typeof workspaceManifestEntrySchema>>[];
  repository_components: readonly DeepReadonly<z.input<typeof repositoryComponentSchema>>[];
  audit?: DeepReadonly<z.input<typeof createdMetadataSchema>>;
}): WorkspaceFingerprintV2 {
  if (input.entries.length > 250000) throw new WorkspaceDomainError([{ code: "workspace-fingerprint-invalid", subject: "entries" }]);
  const entries = [...input.entries].sort((a, b) => compareText(a.path, b.path));
  // First parse each entry to reject unknown keys before computing any identity.
  const parsedEntries = entries.map((entry) => required(checked(workspaceManifestEntrySchema, entry, "workspace-fingerprint-invalid")));
  const manifest = required(checked(workspacePathManifestSchema, { ...manifestSubject(parsedEntries),
    hash: hashCanonical(manifestSubject(parsedEntries)) }, "workspace-fingerprint-invalid"));
  const subject = required(checked(workspaceFingerprintSubjectSchema, {
    ...input.binding, schema: "aira.dev/workspace-fingerprint-subject/v2", manifest,
    state_components: stateComponents(manifest.entries),
    repository_components: [...input.repository_components].sort((a, b) => compareText(a.kind, b.kind)),
  }, "workspace-fingerprint-invalid"));
  const digest = hashCanonical(subject);
  return required(checked(workspaceFingerprintV2Schema, { schema: "aira.dev/workspace-fingerprint/v2",
    id: `workspace_fingerprint_${digest.slice(7)}`, digest, subject, ...(input.audit ? { audit: input.audit } : {}) },
  "workspace-fingerprint-invalid"));
}

/** An exact semantic binding check; not proof that a path or snapshot bytes exist. */
export function fingerprintHandleIssues(fingerprint: unknown, handle: WorkspaceHandleV2): DomainIssue[] {
  const parsed = workspaceFingerprintV2Schema.safeParse(fingerprint);
  if (!parsed.success) return [{ code: "workspace-fingerprint-invalid" }];
  const f = parsed.data.subject, issues: DomainIssue[] = [];
  if (f.control_project !== handle.control_project || f.workspace_id !== handle.id ||
      f.project !== handle.project || f.repository !== handle.repository)
    issues.push({ code: "workspace-fingerprint-workspace-mismatch" });
  if (f.incarnation !== handle.incarnation)
    issues.push({ code: "workspace-fingerprint-incarnation-mismatch" });
  if (!exact(f.provider, handle.provider) || !exact(f.policy, handle.fingerprint_policy))
    issues.push({ code: "workspace-fingerprint-policy-mismatch" });
  if (f.source_observation !== handle.source.id || !exact(f.base, handle.source.subject.source.base))
    issues.push({ code: "workspace-fingerprint-base-mismatch" });
  return stableIssues(issues);
}
