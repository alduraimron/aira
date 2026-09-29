import { z } from "zod";
import { hashCanonical } from "../canonical-json";
import { contentHashSchema, compareText, type DeepReadonly } from "../spec/domain/primitives";
import { controlProjectIdSchema, projectIdentitySchema, repositoryIdentitySchema } from "../workspace/ids";
import { validLogicalPath, aliasKey } from "../workspace-local/manifest";
import { freeze } from "../workspace/domain";
import type { GitObservation, GitObservationSubject } from "./types";

const mode = z.enum(["100644", "100755", "120000", "160000"]);
const object = z.strictObject({ mode, oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) });
const change = z.strictObject({ path: z.string(), kind: z.enum(["addition", "modification", "deletion",
  "mode-change", "type-change", "rename", "copy"]), from: z.string().optional(),
  before: z.strictObject({ mode, oid: object.shape.oid.optional() }).optional(),
  after: z.strictObject({ mode, oid: object.shape.oid.optional() }).optional() });
const head = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("attached"), ref: z.string(), commit: object.shape.oid }),
  z.strictObject({ kind: z.literal("detached"), commit: object.shape.oid }),
  z.strictObject({ kind: z.literal("unborn"), ref: z.string() }), z.strictObject({ kind: z.literal("invalid") }),
]);
const sorted = (items: readonly { readonly path: string }[]) => items.every((item, i) =>
  validLogicalPath(item.path, 4096) && (i === 0 || compareText(items[i - 1]!.path, item.path) < 0));
const paths = (items: readonly string[]) => items.every((item, i) =>
  validLogicalPath(item, 4096) && (i === 0 || compareText(items[i - 1]!, item) < 0));
export const gitObservationSubjectSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-git-observation-subject/v1"),
  control_project: controlProjectIdSchema, project: projectIdentitySchema,
  registered_root_association: contentHashSchema, repository: repositoryIdentitySchema,
  worktree: z.strictObject({ kind: z.enum(["main", "linked"]), identity: contentHashSchema }),
  object_format: z.enum(["sha1", "sha256"]), head, base_commit: object.shape.oid.optional(),
  state: z.enum(["normal", "unborn", "bare", "sparse", "partial", "unmerged-index", "submodules", "nested-repository"]),
  index: z.array(z.strictObject({ path: z.string(), mode, oid: object.shape.oid })).max(250000),
  staged: z.array(change).max(250000), tracked: z.array(change).max(250000),
  untracked: z.array(z.string()).max(250000), ignored: z.array(z.string()).max(250000),
  submodules: z.array(z.strictObject({ path: z.string(), mode, oid: object.shape.oid })).max(10000),
  exclusions: z.strictObject({ paths: z.array(z.string()).max(34) }),
  policy_hash: contentHashSchema, capture_policy_hash: contentHashSchema,
}).superRefine((s, ctx) => {
  const len = s.object_format === "sha1" ? 40 : 64;
  const validOids = s.index.every((e) => e.oid.length === len) &&
    s.submodules.every((e) => e.oid.length === len) &&
    [...s.staged, ...s.tracked].every((e) => (!e.before?.oid || e.before.oid.length === len) &&
      (!e.after?.oid || e.after.oid.length === len));
  const all = [...s.index.map((e) => e.path), ...s.staged.map((e) => e.path), ...s.tracked.map((e) => e.path),
    ...s.untracked, ...s.ignored, ...s.submodules.map((e) => e.path)];
  if (!validOids || !sorted(s.index) || !sorted(s.staged) || !sorted(s.tracked) ||
      !sorted(s.submodules) || !paths(s.untracked) || !paths(s.ignored) || !paths(s.exclusions.paths) ||
      new Map(all.map((p) => [aliasKey(p), p])).size !== new Set(all).size ||
      all.some((p) => p === ".git" || p.startsWith(".git/") || p === ".aira" || p.startsWith(".aira/") ||
        s.exclusions.paths.some((e) => p === e || p.startsWith(`${e}/`))) ||
      (s.head.kind === "attached" || s.head.kind === "detached" ?
        s.base_commit !== s.head.commit || s.head.commit.length !== len : s.base_commit !== undefined) ||
      s.state === "normal" && (s.head.kind === "unborn" || s.head.kind === "invalid" || s.submodules.length !== 0) ||
      s.state === "unborn" && s.head.kind !== "unborn" ||
      s.submodules.some((e) => e.mode !== "160000"))
    ctx.addIssue({ code: "custom", message: "workspace-git-policy-incompatible" });
});
export const gitObservationSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-git-observation/v1"), subject: gitObservationSubjectSchema,
  hash: contentHashSchema,
  audit: z.strictObject({ root: z.string(), git_dir: z.string(), common_dir: z.string(),
    index_byte_hash: z.union([contentHashSchema, z.literal("absent")]), tracked_aira: z.array(z.string()),
    started_at: z.string(), ended_at: z.string() }),
}).refine((o) => o.hash === hashCanonical(o.subject), "workspace-git-policy-incompatible");
/** Pure sorted subject constructor, used by the inspector and deterministic parser tests. */
export function createGitObservation(subject: GitObservationSubject, audit: GitObservation["audit"]): GitObservation {
  const normalized = {
    ...subject, index: [...subject.index].sort((a, b) => compareText(a.path, b.path)),
    staged: [...subject.staged].sort((a, b) => compareText(a.path, b.path)),
    tracked: [...subject.tracked].sort((a, b) => compareText(a.path, b.path)),
    untracked: [...subject.untracked].sort(compareText), ignored: [...subject.ignored].sort(compareText),
    submodules: [...subject.submodules].sort((a, b) => compareText(a.path, b.path)),
    exclusions: { paths: [...subject.exclusions.paths].sort(compareText) },
  };
  const parsed = gitObservationSchema.parse({ schema: "aira.dev/workspace-git-observation/v1",
    subject: normalized, hash: hashCanonical(normalized), audit });
  return freeze(parsed) as DeepReadonly<typeof parsed>;
}
