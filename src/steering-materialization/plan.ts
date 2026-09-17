import { compareText, exact } from "../spec/domain/primitives";
import { steeringResourceIdSchema, type SteeringResourceId } from "../steering/ids";
import { steeringProjectNamespaceSchema, steeringResourceRevisionSchema } from "../steering/schema";
import { STEERING_SOURCE_ROOT, steeringSourcePathSchema } from "../steering-source";
import { StorageError } from "../storage/errors";
import {
  steeringRegistrySchema,
  type SteeringStoreSnapshot,
} from "../storage/steering-types";
import {
  MaterializationFilesystemError,
  observeMaterializationDirectories,
  observeMaterializationTarget,
} from "./fs";
import {
  authorableSteeringSemanticsMatch,
  renderNativeSteeringSource,
} from "./render";
import {
  STEERING_MATERIALIZATION_PLAN_SCHEMA,
  freezeSteeringMaterialization,
  materializationPortablePathKey,
  stableSteeringMaterializationIssues,
  steeringMaterializationActionId,
  steeringMaterializationActionSchema,
  steeringMaterializationAuthorityResourceSchema,
  steeringMaterializationPlanHash,
  steeringMaterializationPlanIdFromHash,
  steeringMaterializationPlanSchema,
  type MaterializationDirectoryObservation,
  type MaterializationTargetState,
  type SteeringMaterializationAction,
  type SteeringMaterializationAuthorityResource,
  type SteeringMaterializationIssue,
  type SteeringMaterializationPlan,
  type SteeringMaterializationPlanInput,
  type SteeringMaterializationPlanResult,
} from "./types";

function failure(issues: readonly SteeringMaterializationIssue[]): SteeringMaterializationPlanResult {
  return { ok: false, issues: freezeSteeringMaterialization(stableSteeringMaterializationIssues(issues)) };
}

function invalid(detail: string, resource?: SteeringResourceId, targetPath?: string): SteeringMaterializationIssue {
  return {
    code: "materialization-plan-invalid",
    ...(resource === undefined ? {} : { resource }),
    ...(targetPath === undefined ? {} : { target_path: targetPath as never }),
    detail,
  };
}

function aliases<T>(
  first: T | undefined,
  second: T | undefined,
  detail: string,
): { value?: T; issue?: SteeringMaterializationIssue } {
  if (first !== undefined && second !== undefined && !exact(first, second))
    return { issue: invalid(detail) };
  return { value: first ?? second };
}

function resourceSelection(
  input: SteeringMaterializationPlanInput,
  snapshot: SteeringStoreSnapshot,
): { resources?: readonly SteeringResourceId[]; issues: SteeringMaterializationIssue[] } {
  const aliasesResult = aliases(input.resources, input.resource_ids, "resource-selection-alias-mismatch");
  if (aliasesResult.issue) return { issues: [aliasesResult.issue] };
  const active = snapshot.registry.resources.filter((resource) => resource.status === "active").map((resource) => resource.id)
    .sort(compareText);
  const raw = aliasesResult.value ?? active;
  if (!Array.isArray(raw)) return { issues: [invalid("resource-selection-shape")] };
  const selected: SteeringResourceId[] = [];
  for (const value of raw) {
    const parsed = steeringResourceIdSchema.safeParse(value);
    if (!parsed.success) return { issues: [invalid("invalid-resource-selection")] };
    selected.push(parsed.data);
  }
  if (new Set(selected).size !== selected.length) return { issues: [invalid("duplicate-resource-selection")] };
  for (const id of selected) {
    const resource = snapshot.registry.resources.find((entry) => entry.id === id);
    if (resource === undefined || resource.status !== "active") return { issues: [invalid("resource-not-active", id)] };
  }
  return { resources: [...selected].sort(compareText), issues: [] };
}

function targetsFor(input: SteeringMaterializationPlanInput): { targets?: Readonly<Record<string, string>>; issues: SteeringMaterializationIssue[] } {
  const result = aliases(input.targets, input.target_paths, "target-selection-alias-mismatch");
  if (result.issue) return { issues: [result.issue] };
  if (result.value === undefined) return { targets: {}, issues: [] };
  if (result.value === null || typeof result.value !== "object" || Array.isArray(result.value) ||
    Object.entries(result.value).some(([, target]) => typeof target !== "string")) return { issues: [invalid("targets-shape")] };
  return { targets: result.value, issues: [] };
}

function replacementsFor(input: SteeringMaterializationPlanInput): { resources?: ReadonlySet<SteeringResourceId>; issues: SteeringMaterializationIssue[] } {
  const result = aliases(input.replace, input.replacement_resources, "replacement-selection-alias-mismatch");
  if (result.issue) return { issues: [result.issue] };
  const values = result.value ?? [];
  if (!Array.isArray(values)) return { issues: [invalid("replacement-selection-shape")] };
  const selected: SteeringResourceId[] = [];
  for (const value of values) {
    const parsed = steeringResourceIdSchema.safeParse(value);
    if (!parsed.success) return { issues: [invalid("invalid-replacement-selection")] };
    selected.push(parsed.data);
  }
  if (new Set(selected).size !== selected.length) return { issues: [invalid("duplicate-replacement-selection")] };
  return { resources: new Set(selected), issues: [] };
}

/** Conventional paths are ergonomic only. Logical identity remains frontmatter data. */
export function suggestSteeringMaterializationTarget(revisionValue: unknown): string {
  const revision = steeringResourceRevisionSchema.parse(revisionValue);
  if (revision.kind === "custom") return `${STEERING_SOURCE_ROOT}/custom/${revision.identity.id}.md`;
  return `${STEERING_SOURCE_ROOT}/${revision.kind}.md`;
}

function forbiddenTarget(targetPath: string): boolean {
  // This adapter owns only the native Steering surface. Keep the separate
  // interoperability filename outside its materialization contract.
  return targetPath.split("/").at(-1) === ["AGENTS", "md"].join(".");
}

function unsafeTarget(
  detail: string,
  authority: SteeringMaterializationAuthorityResource,
  targetPath: string,
): SteeringMaterializationIssue {
  return { code: "materialization-path-unsafe", resource: authority.id, target_path: targetPath as never, detail };
}

function safeTarget(
  targetPath: string,
  authority: SteeringMaterializationAuthorityResource,
): SteeringMaterializationIssue | undefined {
  if (forbiddenTarget(targetPath)) return unsafeTarget("interoperability-target-forbidden", authority, targetPath);
  if (!steeringSourcePathSchema.safeParse(targetPath).success || !targetPath.startsWith(`${STEERING_SOURCE_ROOT}/`) ||
    !targetPath.endsWith(".md") || targetPath.includes("\\") || targetPath.includes(":"))
    return unsafeTarget("target-path", authority, targetPath);
  const parts = targetPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part)))
    return unsafeTarget("target-path", authority, targetPath);
  const sourceParts = targetPath.slice(`${STEERING_SOURCE_ROOT}/`.length).split("/");
  if ((sourceParts[0] === "custom" && sourceParts.length - 2 > 4) ||
    (sourceParts[0] !== "custom" && sourceParts.length !== 1))
    return unsafeTarget("target-recursion", authority, targetPath);
  if (authority.kind === "custom" && !targetPath.startsWith(`${STEERING_SOURCE_ROOT}/custom/`))
    return unsafeTarget("custom-target-outside-custom-root", authority, targetPath);
  return undefined;
}

function authorityResource(
  revision: ReturnType<typeof steeringResourceRevisionSchema.parse>,
  semanticsHash: string,
): SteeringMaterializationAuthorityResource {
  return steeringMaterializationAuthorityResourceSchema.parse({
    id: revision.identity.id,
    revision: revision.identity,
    body: revision.content,
    kind: revision.kind,
    ...(revision.custom_kind === undefined ? {} : { custom_kind: revision.custom_kind }),
    authorable_semantics_hash: semanticsHash,
  }) as SteeringMaterializationAuthorityResource;
}

function existingMatchesAuthority(
  revision: ReturnType<typeof steeringResourceRevisionSchema.parse>,
  target: MaterializationTargetState,
): boolean {
  return target.status === "present" && target.file.proposal !== undefined &&
    exact(revision.content, target.file.proposal.content) &&
    authorableSteeringSemanticsMatch(revision, target.file.proposal);
}

function filesystemIssue(error: unknown, resource?: SteeringResourceId, targetPath?: string): SteeringMaterializationIssue {
  const detail = error instanceof MaterializationFilesystemError ? error.reason : "filesystem-observation-failed";
  return { code: "materialization-path-unsafe", ...(resource === undefined ? {} : { resource }),
    ...(targetPath === undefined ? {} : { target_path: targetPath as never }), detail };
}

async function loadSnapshot(input: SteeringMaterializationPlanInput): Promise<{ snapshot?: SteeringStoreSnapshot; issues: SteeringMaterializationIssue[] }> {
  if (!steeringProjectNamespaceSchema.safeParse(input.project).success) return { issues: [invalid("project")] };
  try {
    const snapshot = await input.store.loadRegistry(input.project as never);
    const registry = steeringRegistrySchema.safeParse(snapshot.registry);
    if (!registry.success || snapshot.registry.project !== input.project || snapshot.head.project !== input.project ||
      snapshot.head.steering_generation !== snapshot.registry.generation)
      return { issues: [invalid("registry-observation")] };
    return { snapshot, issues: [] };
  } catch (error) {
    if (error instanceof StorageError && error.code === "STORE_NOT_FOUND") return { issues: [invalid("registry-absent")] };
    throw error;
  }
}

/**
 * Read-only authority-to-authoring planning. It loads exact current authority,
 * immutable body blobs, and exact target observations, but writes nothing.
 */
export async function planSteeringMaterialization(input: SteeringMaterializationPlanInput): Promise<SteeringMaterializationPlanResult> {
  if (!input || typeof input !== "object") return failure([invalid("input")]);
  const loaded = await loadSnapshot(input);
  if (loaded.issues.length || loaded.snapshot === undefined) return failure(loaded.issues);
  const snapshot = loaded.snapshot;
  const selection = resourceSelection(input, snapshot);
  if (selection.issues.length || selection.resources === undefined) return failure(selection.issues);
  const targetSelection = targetsFor(input);
  if (targetSelection.issues.length || targetSelection.targets === undefined) return failure(targetSelection.issues);
  const replacements = replacementsFor(input);
  if (replacements.issues.length || replacements.resources === undefined) return failure(replacements.issues);
  const selectedSet = new Set(selection.resources);
  for (const raw of Object.keys(targetSelection.targets)) {
    const id = steeringResourceIdSchema.safeParse(raw);
    if (!id.success || !selectedSet.has(id.data)) return failure([invalid("target-for-unselected-resource")]);
  }
  for (const id of replacements.resources) if (!selectedSet.has(id)) return failure([invalid("replacement-for-unselected-resource", id)]);

  const prepared: {
    readonly revision: ReturnType<typeof steeringResourceRevisionSchema.parse>;
    readonly authority: SteeringMaterializationAuthorityResource;
    readonly target_path: string;
    readonly rendered: Awaited<ReturnType<typeof renderNativeSteeringSource>> & { readonly ok: true };
  }[] = [];
  for (const id of selection.resources) {
    const entry = snapshot.registry.resources.find((resource) => resource.id === id && resource.status === "active");
    const revisionValue = entry?.status === "active" ? snapshot.revisions.find((candidate) =>
      exact(candidate.identity, entry.current)) : undefined;
    const parsed = steeringResourceRevisionSchema.safeParse(revisionValue);
    if (!parsed.success || entry === undefined || entry.status !== "active") return failure([invalid("current-resource-revision-missing", id)]);
    if (parsed.data.content.media_type !== "text/markdown; charset=utf-8")
      return failure([{ code: "materialization-render-invalid", resource: id, detail: "authoritative-body-media-type" }]);
    let body: Uint8Array;
    try { body = await input.blobs.get(parsed.data.content.hash); }
    catch { return failure([{ code: "materialization-render-invalid", resource: id, detail: "authoritative-body-unavailable" }]); }
    const targetPath = targetSelection.targets[String(id)] ?? suggestSteeringMaterializationTarget(parsed.data);
    const preliminary = authorityResource(parsed.data, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    const targetIssue = safeTarget(targetPath, preliminary);
    if (targetIssue !== undefined) return failure([targetIssue]);
    const rendered = renderNativeSteeringSource({ project: input.project, target_path: targetPath, revision: parsed.data, body });
    if (!rendered.ok) return failure([rendered.issue]);
    prepared.push({ revision: parsed.data, authority: authorityResource(parsed.data, rendered.authorable_semantics_hash), target_path: targetPath, rendered });
  }

  const collisions: SteeringMaterializationIssue[] = [];
  const exactPaths = new Map<string, string>(), portablePaths = new Map<string, string>();
  for (const entry of prepared) {
    const exactPrior = exactPaths.get(entry.target_path);
    if (exactPrior !== undefined) collisions.push({ code: "materialization-target-collision", resource: entry.revision.identity.id,
      target_path: entry.target_path as never, related_paths: [exactPrior, entry.target_path].sort(compareText), detail: "exact-target-collision" });
    exactPaths.set(entry.target_path, entry.target_path);
    const portable = materializationPortablePathKey(entry.target_path);
    const portablePrior = portablePaths.get(portable);
    if (portablePrior !== undefined && portablePrior !== entry.target_path) collisions.push({ code: "materialization-target-collision",
      resource: entry.revision.identity.id, target_path: entry.target_path as never,
      related_paths: [portablePrior, entry.target_path].sort(compareText), detail: "portable-target-collision" });
    portablePaths.set(portable, entry.target_path);
  }
  if (collisions.length) return failure(collisions);

  const ordered = [...prepared].sort((left, right) => compareText(left.target_path, right.target_path) ||
    compareText(left.revision.identity.id, right.revision.identity.id));
  let directories: readonly MaterializationDirectoryObservation[];
  try { directories = await observeMaterializationDirectories(input.project_root, ordered.map((entry) => entry.target_path)); }
  catch (error) { return failure([filesystemIssue(error)]); }

  const actions: SteeringMaterializationAction[] = [];
  for (const entry of ordered) {
    let observed;
    try { observed = await observeMaterializationTarget(input.project_root, input.project, entry.target_path); }
    catch (error) { return failure([filesystemIssue(error, entry.revision.identity.id, entry.target_path)]); }
    const source = {
      resource: entry.revision.identity.id,
      authority: entry.authority,
      target_path: entry.target_path,
      target: observed.state,
      rendered: entry.rendered.source,
    };
    const value = observed.state.status === "absent" ? { ...source, kind: "create" as const } :
      existingMatchesAuthority(entry.revision, observed.state) ? { ...source, kind: "unchanged" as const } :
        replacements.resources.has(entry.revision.identity.id) ? { ...source, kind: "replace" as const } : {
          ...source,
          kind: "conflict" as const,
          issues: [{ code: "materialization-target-conflict" as const, resource: entry.revision.identity.id,
            target_path: entry.target_path as never,
            detail: observed.state.file.proposal === undefined ? "existing-source-invalid" : "existing-source-differs" }],
        };
    const actionId = steeringMaterializationActionId(value as SteeringMaterializationAction);
    actions.push(steeringMaterializationActionSchema.parse({ ...value, action_id: actionId }) as SteeringMaterializationAction);
  }
  for (const id of replacements.resources) if (!actions.some((action) => action.resource === id && action.kind === "replace"))
    return failure([invalid("replacement-not-required", id)]);

  const authorityResources = [...actions].map((action) => action.authority).sort((left, right) => compareText(left.id, right.id));
  const absentDirectories = directories.filter((directory) => directory.status === "absent").map((directory) => directory.path);
  const base = {
    schema: STEERING_MATERIALIZATION_PLAN_SCHEMA,
    project: input.project,
    control: { authoring_root: STEERING_SOURCE_ROOT },
    renderer: {
      contract: "aira.dev/steering-materialization-renderer/native-source/v1" as const,
      source_schema: "aira.dev/steering-source/v1" as const,
      source_observation_schema: "aira.dev/steering-source-observation/v1" as const,
      frontmatter_encoding: "aira.dev/canonical-json/v1-as-yaml-1.2" as const,
    },
    policy: {
      contract: "aira.dev/steering-materialization-policy/v1" as const,
      existing_file_policy: "preserve-unless-exact-replace" as const,
      publication: "durable-atomic-per-file/v1" as const,
      multi_file_atomicity: "none" as const,
    },
    authority: {
      project: input.project,
      head: snapshot.head,
      commit_sequence: snapshot.head.sequence,
      steering_generation: snapshot.registry.generation,
      resources: authorityResources,
    },
    directories,
    create_directories: absentDirectories,
    actions,
    authorization: actions.some((action) => action.kind === "replace") ? {
      replacement: "required" as const,
      required: true as const,
      contract: "aira.dev/steering-materialization-authorization/v1" as const,
      actor_kind: "human" as const,
      worker_self_modification: "forbidden" as const,
    } : { replacement: "not-required" as const, required: false as const },
  };
  const placeholder = {
    ...base,
    id: "steering_materialization_plan_0000000000000000000000000000000000000000000000000000000000",
    hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  } as unknown as SteeringMaterializationPlan;
  const hash = steeringMaterializationPlanHash(placeholder);
  const plan = steeringMaterializationPlanSchema.parse({ ...base, id: steeringMaterializationPlanIdFromHash(hash), hash }) as SteeringMaterializationPlan;
  return { ok: true, plan: freezeSteeringMaterialization(plan) };
}

export const inspectAndPlanSteeringMaterialization = planSteeringMaterialization;
export const createSteeringMaterializationPlan = planSteeringMaterialization;
export const buildSteeringMaterializationPlan = planSteeringMaterialization;
export const planAuthoritativeSteeringMaterialization = planSteeringMaterialization;
export const suggestNativeSteeringMaterializationTarget = suggestSteeringMaterializationTarget;
