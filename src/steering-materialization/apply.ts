import { exact } from "../spec/domain/primitives";
import { steeringProjectNamespaceSchema, steeringResourceRevisionSchema } from "../steering/schema";
import { StorageError } from "../storage/errors";
import { steeringRegistrySchema, type SteeringStoreSnapshot } from "../storage/steering-types";
import {
  MaterializationFilesystemError,
  assertMaterializationDirectoryPreconditions,
  ensureMaterializationDirectories,
  materializationTargetStateMatches,
  observeMaterializationTarget,
  publishMaterializationTarget,
} from "./fs";
import {
  authorableSteeringSemanticsHash,
  authorableSteeringSemanticsMatch,
  renderNativeSteeringSource,
} from "./render";
import {
  freezeSteeringMaterialization,
  materializationRevisionReferences,
  stableSteeringMaterializationIssues,
  steeringMaterializationAuthorizationSchema,
  steeringMaterializationAuthorityResourceSchema,
  steeringMaterializationFileSchema,
  steeringMaterializationResultSchema,
  validateSteeringMaterializationPlan,
  type SteeringMaterializationAction,
  type SteeringMaterializationApplyInput,
  type SteeringMaterializationApplyResult,
  type SteeringMaterializationAuthorization,
  type SteeringMaterializationAuthorityResource,
  type SteeringMaterializationFile,
  type SteeringMaterializationIssue,
  type SteeringMaterializationPlan,
  type SteeringMaterializationResult,
  type SteeringMaterializationWriteAction,
} from "./types";

interface CurrentAuthority {
  readonly snapshot: SteeringStoreSnapshot;
  readonly revisions: ReadonlyMap<string, ReturnType<typeof steeringResourceRevisionSchema.parse>>;
}

class MaterializationAuthorityFreshnessError extends Error {
  readonly materialization_authority_stale = true;
  constructor(readonly issues: readonly SteeringMaterializationIssue[]) {
    super("materialization-authority-stale");
    this.name = "MaterializationAuthorityFreshnessError";
  }
}

function failure(issues: readonly SteeringMaterializationIssue[], result?: SteeringMaterializationResult): SteeringMaterializationApplyResult {
  return {
    ok: false,
    ...(result === undefined ? {} : { result }),
    issues: freezeSteeringMaterialization(stableSteeringMaterializationIssues(issues)),
  };
}

function filesystemIssue(error: unknown, action?: SteeringMaterializationAction): SteeringMaterializationIssue {
  if (error instanceof MaterializationAuthorityFreshnessError) {
    const issue = error.issues[0] ?? { code: "materialization-authority-stale" as const };
    return {
      ...issue,
      ...(action === undefined || issue.resource !== undefined ? {} : { resource: action.resource }),
      ...(action === undefined || issue.action !== undefined ? {} : { action: action.action_id }),
      ...(action === undefined || issue.target_path !== undefined ? {} : { target_path: action.target_path }),
    };
  }
  const filesystem = error instanceof MaterializationFilesystemError ? error : undefined;
  const targetPath = action?.target_path ?? filesystem?.target_path;
  return {
    code: filesystem?.stale ? "materialization-target-stale" : "materialization-path-unsafe",
    ...(action === undefined ? {} : { resource: action.resource, action: action.action_id }),
    ...(targetPath === undefined ? {} : { target_path: targetPath as never }),
    detail: filesystem?.reason ?? "filesystem-operation-failed",
  };
}

function authorizationFor(
  value: unknown,
  plan: SteeringMaterializationPlan,
): { authorization?: SteeringMaterializationAuthorization; issues: SteeringMaterializationIssue[] } {
  if (plan.authorization.replacement === "not-required") return { issues: [] };
  if (value === undefined || value === null)
    return { issues: [{ code: "materialization-replacement-unauthorized", detail: "authorization-missing" }] };
  const raw = value as { by?: { kind?: unknown }; actor?: { kind?: unknown } };
  const actor = raw.by ?? raw.actor;
  if (actor?.kind === "worker" || actor?.kind === "model")
    return { issues: [{ code: "materialization-worker-unauthorized", detail: "nonhuman-actor" }] };
  const parsed = steeringMaterializationAuthorizationSchema.safeParse(value);
  if (!parsed.success) return { issues: [{ code: "materialization-replacement-unauthorized", detail: "authorization-invalid" }] };
  const authorization = parsed.data as SteeringMaterializationAuthorization;
  if (authorization.project !== plan.project || authorization.plan.id !== plan.id || authorization.plan.hash !== plan.hash)
    return { issues: [{ code: "materialization-replacement-unauthorized", detail: "authorization-plan-mismatch" }] };
  return { authorization, issues: [] };
}

function authorityRecord(revision: ReturnType<typeof steeringResourceRevisionSchema.parse>): SteeringMaterializationAuthorityResource {
  return steeringMaterializationAuthorityResourceSchema.parse({
    id: revision.identity.id,
    revision: revision.identity,
    body: revision.content,
    kind: revision.kind,
    ...(revision.custom_kind === undefined ? {} : { custom_kind: revision.custom_kind }),
    authorable_semantics_hash: authorableSteeringSemanticsHash(revision),
  }) as SteeringMaterializationAuthorityResource;
}

async function currentAuthority(
  input: SteeringMaterializationApplyInput,
  plan: SteeringMaterializationPlan,
): Promise<{ authority?: CurrentAuthority; issues: SteeringMaterializationIssue[] }> {
  let snapshot: SteeringStoreSnapshot;
  try { snapshot = await input.store.loadRegistry(plan.project as never); }
  catch (error) {
    if (error instanceof StorageError && error.code === "STORE_NOT_FOUND")
      return { issues: [{ code: "materialization-authority-stale", detail: "registry-missing" }] };
    throw error;
  }
  const registry = steeringRegistrySchema.safeParse(snapshot.registry);
  if (!registry.success || snapshot.registry.project !== plan.project || snapshot.head.project !== plan.project ||
    snapshot.head.steering_generation !== snapshot.registry.generation)
    return { issues: [{ code: "materialization-authority-stale", detail: "registry-observation-invalid" }] };
  const records: SteeringMaterializationAuthorityResource[] = [];
  const revisions = new Map<string, ReturnType<typeof steeringResourceRevisionSchema.parse>>();
  for (const expected of plan.authority.resources) {
    const entry = snapshot.registry.resources.find((resource) => resource.id === expected.id);
    if (entry === undefined || entry.status !== "active" || !exact(entry.current, expected.revision))
      return { issues: [{ code: "materialization-authority-stale", resource: expected.id, detail: "current-revision-changed" }] };
    const candidate = snapshot.revisions.find((revision) => exact(revision.identity, expected.revision));
    const parsed = steeringResourceRevisionSchema.safeParse(candidate);
    if (!parsed.success) return { issues: [{ code: "materialization-authority-stale", resource: expected.id, detail: "current-revision-unavailable" }] };
    let record: SteeringMaterializationAuthorityResource;
    try { record = authorityRecord(parsed.data); }
    catch { return { issues: [{ code: "materialization-authority-stale", resource: expected.id, detail: "current-revision-unrenderable" }] }; }
    if (!exact(record, expected))
      return { issues: [{ code: "materialization-authority-stale", resource: expected.id, detail: "resource-render-input-changed" }] };
    records.push(record); revisions.set(String(expected.id), parsed.data);
  }
  const observed = {
    project: plan.project,
    head: snapshot.head,
    commit_sequence: snapshot.head.sequence,
    steering_generation: snapshot.registry.generation,
    resources: records.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  };
  if (!exact(observed, plan.authority))
    return { issues: [{ code: "materialization-authority-stale", detail: "head-or-generation-changed" }] };
  return { authority: { snapshot, revisions }, issues: [] };
}

async function renderedBytes(
  input: SteeringMaterializationApplyInput,
  plan: SteeringMaterializationPlan,
  authority: CurrentAuthority,
): Promise<{ bytes?: ReadonlyMap<string, Uint8Array>; issues: SteeringMaterializationIssue[] }> {
  const output = new Map<string, Uint8Array>();
  const issues: SteeringMaterializationIssue[] = [];
  for (const action of plan.actions) {
    const revision = authority.revisions.get(String(action.resource));
    if (revision === undefined) {
      issues.push({ code: "materialization-authority-stale", resource: action.resource, action: action.action_id,
        target_path: action.target_path, detail: "selected-revision-missing" });
      continue;
    }
    let body: Uint8Array;
    try { body = await input.blobs.get(revision.content.hash); }
    catch {
      issues.push({ code: "materialization-render-invalid", resource: action.resource, action: action.action_id,
        target_path: action.target_path, detail: "authoritative-body-unavailable" });
      continue;
    }
    const rendered = renderNativeSteeringSource({ project: plan.project, target_path: action.target_path, revision, body });
    if (!rendered.ok) {
      issues.push({ ...rendered.issue, action: action.action_id });
      continue;
    }
    if (!exact(rendered.source, action.rendered) || rendered.authorable_semantics_hash !== action.authority.authorable_semantics_hash) {
      issues.push({ code: "materialization-authority-stale", resource: action.resource, action: action.action_id,
        target_path: action.target_path, detail: "renderer-input-or-contract-changed" });
      continue;
    }
    output.set(String(action.action_id), Uint8Array.from(rendered.bytes));
  }
  return { ...(issues.length ? {} : { bytes: output }), issues: stableSteeringMaterializationIssues(issues) };
}

function materializedFile(action: SteeringMaterializationAction, observation: Awaited<ReturnType<typeof observeMaterializationTarget>>): SteeringMaterializationFile | undefined {
  if (observation.source_observation === undefined) return undefined;
  return steeringMaterializationFileSchema.parse({
    resource: action.resource,
    revision: action.authority.revision,
    target_path: action.target_path,
    observation: observation.source_observation,
  }) as SteeringMaterializationFile;
}

function resultFor(
  plan: SteeringMaterializationPlan,
  status: SteeringMaterializationResult["status"],
  created: readonly SteeringMaterializationFile[],
  replaced: readonly SteeringMaterializationFile[],
  unchanged: readonly SteeringMaterializationFile[],
  conflicts: readonly SteeringMaterializationIssue[],
  partial: readonly SteeringMaterializationFile[],
  diagnostics: readonly SteeringMaterializationIssue[],
): SteeringMaterializationResult {
  const observations = [...created, ...replaced, ...unchanged]
    .sort((left, right) => left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0);
  return freezeSteeringMaterialization(steeringMaterializationResultSchema.parse({
    schema: "aira.dev/steering-materialization-result/v1",
    status,
    plan: { id: plan.id, hash: plan.hash },
    authority: { head: plan.authority.head, steering_generation: plan.authority.steering_generation },
    resource_revisions: materializationRevisionReferences(plan.actions),
    created_files: created,
    replaced_files: replaced,
    unchanged_files: unchanged,
    conflicts,
    partial_applied_files: partial,
    target_source_observations: observations,
    diagnostics: stableSteeringMaterializationIssues(diagnostics),
  })) as SteeringMaterializationResult;
}

async function preflightTargets(
  input: SteeringMaterializationApplyInput,
  plan: SteeringMaterializationPlan,
  authority: CurrentAuthority,
): Promise<{
  readonly issues: readonly SteeringMaterializationIssue[];
  readonly unchanged: readonly SteeringMaterializationFile[];
}> {
  const issues: SteeringMaterializationIssue[] = [];
  try { await assertMaterializationDirectoryPreconditions(input.project_root, plan.directories); }
  catch (error) { issues.push(filesystemIssue(error)); }
  const unchanged: SteeringMaterializationFile[] = [];
  for (const action of plan.actions) {
    let current;
    try { current = await observeMaterializationTarget(input.project_root, plan.project, action.target_path); }
    catch (error) { issues.push(filesystemIssue(error, action)); continue; }
    if (!materializationTargetStateMatches(action.target, current.state)) {
      issues.push({ code: "materialization-target-stale", resource: action.resource, action: action.action_id,
        target_path: action.target_path, detail: "target-observation-changed" });
      continue;
    }
    if (action.kind === "unchanged") {
      const revision = authority.revisions.get(String(action.resource));
      const file = materializedFile(action, current);
      if (revision === undefined || file === undefined || current.state.status !== "present" || current.state.file.proposal === undefined ||
        !authorableSteeringSemanticsMatch(revision, current.state.file.proposal)) {
        // The source bytes are bound, so this branch is defensive against a
        // malformed/tampered plan rather than an ordinary human edit.
        issues.push({ code: "materialization-target-stale", resource: action.resource, action: action.action_id,
          target_path: action.target_path, detail: "unchanged-source-not-parseable" });
      } else unchanged.push(file);
    }
  }
  return { issues: stableSteeringMaterializationIssues(issues), unchanged };
}

function plannedConflicts(plan: SteeringMaterializationPlan): SteeringMaterializationIssue[] {
  return plan.actions.filter((action): action is Extract<SteeringMaterializationAction, { kind: "conflict" }> => action.kind === "conflict")
    .flatMap((action) => action.issues.map((issue) => ({ ...issue, action: action.action_id })));
}

/**
 * Revalidate immutable authority and authoring targets, then publish each file
 * independently. It deliberately never calls SteeringStore.commit.
 */
export async function applySteeringMaterialization(input: SteeringMaterializationApplyInput): Promise<SteeringMaterializationApplyResult> {
  if (!input || typeof input !== "object")
    return failure([{ code: "materialization-plan-invalid", detail: "input" }]);
  const planIssues = validateSteeringMaterializationPlan(input.plan);
  if (planIssues.length) return failure(planIssues);
  const plan = freezeSteeringMaterialization(input.plan) as SteeringMaterializationPlan;
  if (!steeringProjectNamespaceSchema.safeParse(plan.project).success)
    return failure([{ code: "materialization-plan-invalid", detail: "project" }]);
  const authorization = authorizationFor(input.authorization, plan);
  if (authorization.issues.length) return failure(authorization.issues);

  const current = await currentAuthority(input, plan);
  if (current.issues.length || current.authority === undefined) {
    const result = resultFor(plan, "failed-before-write", [], [], [], [], [], current.issues);
    return failure(current.issues, result);
  }
  const rendered = await renderedBytes(input, plan, current.authority);
  if (rendered.issues.length || rendered.bytes === undefined) {
    const result = resultFor(plan, "failed-before-write", [], [], [], [], [], rendered.issues);
    return failure(rendered.issues, result);
  }

  const preflight = await preflightTargets(input, plan, current.authority);
  const finalAuthority = await currentAuthority(input, plan);
  if (finalAuthority.issues.length || finalAuthority.authority === undefined) {
    const diagnostics = stableSteeringMaterializationIssues([...preflight.issues, ...finalAuthority.issues]);
    const result = resultFor(plan, "failed-before-write", [], [], preflight.unchanged, [], [], diagnostics);
    return failure(diagnostics, result);
  }
  const conflicts = plannedConflicts(plan);
  if (preflight.issues.length || conflicts.length) {
    const diagnostics = stableSteeringMaterializationIssues([...preflight.issues, ...conflicts]);
    const result = resultFor(plan, "failed-before-write", [], [], preflight.unchanged, conflicts, [], diagnostics);
    return failure(diagnostics, result);
  }

  const writes = plan.actions.filter((action): action is SteeringMaterializationWriteAction => action.kind === "create" || action.kind === "replace");
  if (writes.length === 0) {
    const result = resultFor(plan, "no-op", [], [], preflight.unchanged, [], [], []);
    return { ok: true, result };
  }

  const createdDirectories = new Map<string, import("./types").MaterializationFileIdentity>();
  const created: SteeringMaterializationFile[] = [], replaced: SteeringMaterializationFile[] = [];
  for (const action of writes) {
    let published = false;
    try {
      await ensureMaterializationDirectories(input.project_root, plan.directories, action.target_path, createdDirectories);
      await publishMaterializationTarget({
        project_root: input.project_root,
        target_path: action.target_path,
        bytes: rendered.bytes.get(String(action.action_id))!,
        options: input.file_options,
        revalidate: async () => {
          const authorityAtPublication = await currentAuthority(input, plan);
          if (authorityAtPublication.issues.length || authorityAtPublication.authority === undefined)
            throw new MaterializationAuthorityFreshnessError(authorityAtPublication.issues);
          await ensureMaterializationDirectories(input.project_root, plan.directories, action.target_path, createdDirectories);
          const currentTarget = await observeMaterializationTarget(input.project_root, plan.project, action.target_path);
          if (!materializationTargetStateMatches(action.target, currentTarget.state))
            throw new MaterializationFilesystemError("target-precondition-changed", action.target_path, true);
        },
      });
      published = true;
      const observed = await observeMaterializationTarget(input.project_root, plan.project, action.target_path);
      const file = materializedFile(action, observed);
      if (file === undefined || observed.state.status !== "present" || !exact(observed.state.file.source, action.rendered) ||
        observed.state.file.proposal === undefined || !authorableSteeringSemanticsMatch(current.authority.revisions.get(String(action.resource))!, observed.state.file.proposal))
        throw new MaterializationFilesystemError("published-source-verification-failed", action.target_path, false, undefined, true);
      if (action.kind === "create") created.push(file); else replaced.push(file);
    } catch (error) {
      const filesystem = error instanceof MaterializationFilesystemError ? error : undefined;
      const diagnostic = filesystemIssue(error, action);
      let knownPublished: SteeringMaterializationFile | undefined;
      if (published || filesystem?.published) {
        try {
          const observed = await observeMaterializationTarget(input.project_root, plan.project, action.target_path);
          if (observed.state.status === "present" && exact(observed.state.file.source, action.rendered))
            knownPublished = materializedFile(action, observed);
        } catch {
          // A post-publication observer may itself lose a race. The result stays
          // partial and never claims this file was safely observed.
        }
      }
      if (knownPublished !== undefined) {
        if (action.kind === "create") created.push(knownPublished); else replaced.push(knownPublished);
      }
      const partialFiles = [...created, ...replaced];
      const diagnostics = stableSteeringMaterializationIssues([
        diagnostic,
        ...(partialFiles.length || published || filesystem?.published ? [{ code: "materialization-partial" as const,
          resource: action.resource, action: action.action_id, target_path: action.target_path,
          detail: "per-file-publication-interrupted" }] : []),
      ]);
      const status = partialFiles.length || published || filesystem?.published ? "partial" : "failed-before-write";
      const result = resultFor(plan, status, created, replaced, preflight.unchanged, [], partialFiles, diagnostics);
      return failure(diagnostics, result);
    }
  }
  const result = resultFor(plan, "complete", created, replaced, preflight.unchanged, [], [], []);
  return { ok: true, result };
}

export const applySteeringMaterializationPlan = applySteeringMaterialization;
export const materializeAuthoritativeSteering = applySteeringMaterialization;
