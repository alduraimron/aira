import { exact } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { validateWorkspaceHandle } from "../workspace/handle";
import { inspectWorkspaceGit } from "../workspace-git/inspect";
import { inspectWorkspaceLocalTree, recheckWorkspaceLocalTree } from "../workspace-local/inspect";
import { composeGitWorkspaceFingerprint, composeGitWorkspaceSource } from "./compose";
import { report } from "./coherence";
import type { AdapterPair, CaptureGitSourceInput, CaptureGitWorkspaceInput, CaptureHooks,
  CaptureIssue, CaptureStatus, GitWorkspaceCapture, QuiescenceEvidence } from "./types";

const adapters: AdapterPair = { git: inspectWorkspaceGit, local: inspectWorkspaceLocalTree };
const issue = (code: CaptureIssue["code"], detail?: string): CaptureIssue =>
  ({ code, ...(detail ? { detail } : {}) });
const failed = (status: CaptureStatus, problem: CaptureIssue, extras: Partial<GitWorkspaceCapture> = {}): GitWorkspaceCapture =>
  freeze({ schema: "aira.dev/workspace-git-capture/v1" as const, status, diagnostics: [problem],
    report: report(), ...extras });
const quiescent = (value: unknown): value is QuiescenceEvidence => !!value && typeof value === "object" &&
  (value as QuiescenceEvidence).schema === "aira.dev/workspace-capture-quiescence/v1" &&
  (value as QuiescenceEvidence).held === true && typeof (value as QuiescenceEvidence).token === "string" &&
  (value as QuiescenceEvidence).token.length > 0 && (value as QuiescenceEvidence).token.length <= 256;
const gitFailure = (status: "complete" | "unsupported" | "not-repository" | "unstable") => status === "unstable" ?
  "unstable" as const : status === "complete" ? "incomplete" as const : "unsupported" as const;

/** Read-only G1 -> exact 06-2A tree -> G2 source bootstrap, before a handle can exist. */
export async function captureGitWorkspaceSource(input: CaptureGitSourceInput,
  hooks: CaptureHooks = {}, io: AdapterPair = adapters): Promise<GitWorkspaceCapture> {
  try {
    const q1 = await input.observeQuiescence?.();
    if (input.observeQuiescence && !quiescent(q1))
      return failed("unstable", issue("workspace-capture-git-unstable", "quiescence-lost"));
    const gitOptions = { executionRoot: input.executionRoot, controlProject: input.controlProject,
      project: input.project, registeredRootAssociation: input.registeredRootAssociation,
      capturePolicy: input.capturePolicy };
    const a = await io.git(gitOptions);
    if (a.status !== "complete" || !a.observation)
      return failed(gitFailure(a.status), issue(a.status === "unstable" ? "workspace-capture-git-unstable" :
        "workspace-capture-unsupported", a.diagnostics[0]?.code), { ...(a.observation ? { git_before: a.observation } : {}) });
    await hooks.afterGitBefore?.();
    const local = await io.local({ executionRoot: input.executionRoot, controlRoot: input.controlRoot,
      relationship: input.relationship, capturePolicy: input.capturePolicy }, hooks.local);
    if (local.status !== "complete" || !local.tree)
      return failed("incomplete", issue("workspace-capture-source-incomplete", local.diagnostics[0]?.code),
        { git_before: a.observation, local });
    await hooks.afterLocal?.();
    const b = await io.git(gitOptions);
    if (b.status !== "complete" || !b.observation)
      return failed("unstable", issue("workspace-capture-git-unstable", b.diagnostics[0]?.code),
        { git_before: a.observation, local, ...(b.observation ? { git_after: b.observation } : {}) });
    const q2 = await input.observeQuiescence?.();
    if (input.observeQuiescence && (!quiescent(q2) || !exact(q1, q2)))
      return failed("unstable", issue("workspace-capture-git-unstable", "quiescence-changed"),
        { git_before: a.observation, git_after: b.observation, local });
    const checked = await recheckWorkspaceLocalTree(local);
    if (checked.status !== "match") return failed("unstable", issue("workspace-capture-git-local-mismatch",
      checked.diagnostics[0]?.code), { git_before: a.observation, git_after: b.observation, local });
    return composeGitWorkspaceSource({ git_before: a.observation, git_after: b.observation, local,
      capture_policy: input.capturePolicy, provider: input.provider, audit: input.audit,
      ...(q2 ? { quiescence: q2 } : {}) });
  } catch { return failed("incomplete", issue("workspace-capture-source-incomplete", "adapter-failed")); }
}
/** No prepare, store or ref/index writes. The handle is an exact precondition, not minted here. */
export async function captureGitWorkspaceFingerprint(input: CaptureGitWorkspaceInput,
  hooks: CaptureHooks = {}, io: AdapterPair = adapters): Promise<GitWorkspaceCapture> {
  const parsed = validateWorkspaceHandle(input?.handle);
  if (!parsed.ok) return failed("invalid-input", issue("workspace-capture-invalid-input", "handle"));
  const h = parsed.value;
  if (h.roots.execution.kind !== "local-absolute" || h.roots.control.kind !== "local-absolute" ||
      input.executionRoot !== h.roots.execution.path || h.source.subject.source.kind !== "git" ||
      h.source.subject.source.byte_closure?.status !== "byte-complete")
    return failed("incompatible", issue("workspace-capture-source-incomplete", "unsupported-handle-source"));
  try {
    const reviewedBefore = h.roots.relationship === "separate-root" ? await input.observeReviewedSource?.() : undefined;
    if (h.roots.relationship === "separate-root" && !reviewedBefore)
      return failed("incomplete", issue("workspace-capture-source-incomplete", "source-observer-required"));
    const q1 = await input.observeQuiescence?.();
    if (input.observeQuiescence && !quiescent(q1)) return failed("unstable", issue("workspace-capture-git-unstable", "quiescence-lost"));
    const gitOptions = { executionRoot: input.executionRoot, controlProject: h.control_project,
      project: h.project, registeredRootAssociation: h.source.subject.registered_root_association,
      capturePolicy: h.fingerprint_policy };
    const a = await io.git(gitOptions);
    if (a.status !== "complete" || !a.observation)
      return failed(gitFailure(a.status), issue(a.status === "unstable" ? "workspace-capture-git-unstable" :
        "workspace-capture-unsupported", a.diagnostics[0]?.code), { ...(a.observation ? { git_before: a.observation } : {}) });
    await hooks.afterGitBefore?.();
    const local = await io.local({ executionRoot: input.executionRoot, controlRoot: h.roots.control.path,
      relationship: h.roots.relationship, capturePolicy: h.fingerprint_policy }, hooks.local);
    if (local.status !== "complete" || !local.tree)
      return failed("incomplete", issue("workspace-capture-source-incomplete", local.diagnostics[0]?.code),
        { git_before: a.observation, local });
    await hooks.afterLocal?.();
    const b = await io.git(gitOptions);
    if (b.status !== "complete" || !b.observation)
      return failed("unstable", issue("workspace-capture-git-unstable", b.diagnostics[0]?.code),
        { git_before: a.observation, local, ...(b.observation ? { git_after: b.observation } : {}) });
    const q2 = await input.observeQuiescence?.();
    if (input.observeQuiescence && (!quiescent(q2) || !exact(q1, q2)))
      return failed("unstable", issue("workspace-capture-git-unstable", "quiescence-changed"),
        { git_before: a.observation, git_after: b.observation, local });
    const reviewedAfter = h.roots.relationship === "separate-root" ? await input.observeReviewedSource?.() : undefined;
    const checked = await recheckWorkspaceLocalTree(local);
    if (checked.status !== "match") return failed("unstable", issue("workspace-capture-git-local-mismatch",
      checked.diagnostics[0]?.code), { git_before: a.observation, git_after: b.observation, local });
    return composeGitWorkspaceFingerprint({ handle: h, git_before: a.observation, git_after: b.observation, local,
      capture_policy: h.fingerprint_policy, provider: h.provider, audit: h.created,
      ...(q2 ? { quiescence: q2 } : {}), ...(reviewedBefore ? { reviewed_source_before: reviewedBefore } : {}),
      ...(reviewedAfter ? { reviewed_source_after: reviewedAfter } : {}) });
  } catch { return failed("incomplete", issue("workspace-capture-source-incomplete", "adapter-failed")); }
}
