import { operationIdSchema } from "../spec/domain/ids";
import { compareText, exact } from "../spec/domain/primitives";
import {
  STEERING_AGENTS_INSPECTION_SCHEMA,
  agentsSourcePathSchema,
  inspectAgentsInterop,
} from "../steering-agents";
import { validateSteeringHierarchy } from "../steering/hierarchy";
import { steeringResourceIdSchema, steeringRevisionIdSchema, type SteeringResourceId, type SteeringRevisionReference } from "../steering/ids";
import { validateSteeringRevisionHistory } from "../steering/resources";
import {
  steeringProjectNamespaceSchema,
  steeringResourceRevisionSchema,
  type SteeringResourceRevisionValue,
} from "../steering/schema";
import { StorageError } from "../storage/errors";
import type { SteeringStore } from "../storage/steering-store";
import {
  steeringExpectationFor,
  steeringRegistryRevisionOf,
  steeringRegistrySchema,
  type SteeringRegistry,
  type SteeringResourceExpectation,
  type SteeringStoreSnapshot,
} from "../storage/steering-types";
import {
  constructSteeringAgentsImportRevision,
  agentsImportSourceFor,
  validateAgentsImportRawResource,
} from "./mapping";
import {
  STEERING_AGENTS_IMPORT_PLAN_SCHEMA,
  agentsImportPolicy,
  freezeSteeringAgentsImport,
  stableSteeringAgentsImportIssues,
  steeringAgentsImportActionId,
  steeringAgentsImportActionSchema,
  steeringAgentsImportComparisonSchema,
  steeringAgentsImportPlanHash,
  steeringAgentsImportPlanIdFromHash,
  steeringAgentsImportPlanSchema,
  steeringAgentsImportRegistryObservationSchema,
  type InspectAndPlanSteeringAgentsImportInput,
  type SteeringAgentsImportAction,
  type SteeringAgentsImportComparison,
  type SteeringAgentsImportIssue,
  type SteeringAgentsImportMapping,
  type SteeringAgentsImportPlan,
  type SteeringAgentsImportPlanInput,
  type SteeringAgentsImportPlanResult,
  type SteeringAgentsImportPublicationAction,
  type SteeringAgentsImportRegistryObservation,
  type SteeringAgentsImportSource,
} from "./types";

const planningCreated = {
  at: "1970-01-01T00:00:00.000Z",
  by: { kind: "human", id: "steering-agents-import-plan" },
  operation: operationIdSchema.parse("operation_steering-agents-import-plan"),
  channel: "api",
} as const;

interface RegistryPlanningState {
  readonly snapshot: SteeringStoreSnapshot | null;
  readonly registry: SteeringRegistry | null;
  readonly revisions: readonly SteeringResourceRevisionValue[];
  readonly observation: SteeringAgentsImportRegistryObservation;
}

interface InspectedAgentsImportSource {
  readonly source: SteeringAgentsImportSource;
}

interface ActionDraft {
  readonly resource: SteeringResourceId;
  readonly source: SteeringAgentsImportSource;
  readonly comparison: SteeringAgentsImportComparison;
  readonly expectation: SteeringResourceExpectation;
  kind: "create" | "update" | "unchanged" | "conflict";
  readonly current?: SteeringRevisionReference;
  readonly next?: SteeringRevisionReference;
  readonly supersedes?: SteeringRevisionReference;
  readonly candidate?: SteeringResourceRevisionValue;
  issues: SteeringAgentsImportIssue[];
}

function failure(issues: readonly SteeringAgentsImportIssue[]): SteeringAgentsImportPlanResult {
  return { ok: false, issues: freezeSteeringAgentsImport(stableSteeringAgentsImportIssues(issues)) };
}

function invalid(detail: string, resource?: SteeringResourceId): SteeringAgentsImportIssue {
  return { code: "agents-import-plan-invalid", ...(resource === undefined ? {} : { resource }), detail };
}

function allChanged(): SteeringAgentsImportComparison {
  return steeringAgentsImportComparisonSchema.parse({
    body: "changed",
    source: "changed",
    mapping: "changed",
    representation: "changed",
    authority: "changed",
    scope: "changed",
    inclusion: "changed",
    composition: "changed",
    rules: "changed",
    enforcement: "changed",
    compatibility: "changed",
  }) as SteeringAgentsImportComparison;
}

function mappingMeaning(revision: SteeringResourceRevisionValue): unknown {
  if (revision.provenance.kind !== "interoperability" || revision.provenance.source.kind !== "agents-md") return undefined;
  const attribution = revision.provenance.source.agents_observation;
  return attribution === undefined ? undefined : {
    resource: revision.identity.id,
    policy: revision.provenance.source.import_policy,
    source_path: attribution.source_path,
    source_identity: attribution.source_identity,
    scope: attribution.scope,
    ordering: "broadest-to-nearest-scope-depth-then-source-path/v1",
  };
}

function compareToCandidate(
  current: SteeringResourceRevisionValue,
  candidate: SteeringResourceRevisionValue,
): SteeringAgentsImportComparison {
  const representation = (value: SteeringResourceRevisionValue) => ({
    kind: value.kind,
    ...(value.custom_kind === undefined ? {} : { custom_kind: value.custom_kind }),
    layer: value.layer,
    content_encoding: value.content_encoding,
    metadata: value.metadata,
    behavioral_assets: value.behavioral_assets,
  });
  const authority = (value: SteeringResourceRevisionValue) => ({
    default_authority: value.default_authority,
    default_override_policy: value.default_override_policy,
  });
  const enforcement = (value: SteeringResourceRevisionValue) => ({
    default_enforcement: value.default_enforcement,
    rule_enforcement: value.rules.map((rule) => ({ id: rule.id, enforcement: rule.enforcement })),
  });
  return steeringAgentsImportComparisonSchema.parse({
    body: exact({ identity_hash: current.identity.hash, content: current.content },
      { identity_hash: candidate.identity.hash, content: candidate.content }) ? "unchanged" : "changed",
    source: exact(current.provenance, candidate.provenance) ? "unchanged" : "changed",
    mapping: exact(mappingMeaning(current), mappingMeaning(candidate)) ? "unchanged" : "changed",
    representation: exact(representation(current), representation(candidate)) ? "unchanged" : "changed",
    authority: exact(authority(current), authority(candidate)) ? "unchanged" : "changed",
    scope: exact(current.scope, candidate.scope) ? "unchanged" : "changed",
    inclusion: exact(current.inclusion, candidate.inclusion) ? "unchanged" : "changed",
    composition: exact(current.composition, candidate.composition) ? "unchanged" : "changed",
    rules: exact(current.rules, candidate.rules) ? "unchanged" : "changed",
    enforcement: exact(enforcement(current), enforcement(candidate)) ? "unchanged" : "changed",
    compatibility: exact(current.compatibility, candidate.compatibility) ? "unchanged" : "changed",
  }) as SteeringAgentsImportComparison;
}

function isUnchanged(comparison: SteeringAgentsImportComparison): boolean {
  return Object.values(comparison).every((value) => value === "unchanged");
}

function nextReference(
  resource: SteeringResourceId,
  hash: SteeringRevisionReference["hash"],
  current?: SteeringRevisionReference,
): SteeringRevisionReference | undefined {
  if (current === undefined) return {
    id: resource,
    revision: steeringRevisionIdSchema.parse("1"),
    hash,
  };
  const next = BigInt(current.revision) + 1n;
  if (next > 18_446_744_073_709_551_615n) return undefined;
  return { id: resource, revision: steeringRevisionIdSchema.parse(next.toString()), hash };
}

function registryState(
  input: SteeringStoreSnapshot | null,
  project: string,
): { state?: RegistryPlanningState; issues: SteeringAgentsImportIssue[] } {
  if (input === null) {
    const observation = steeringAgentsImportRegistryObservationSchema.parse({ status: "absent", project }) as SteeringAgentsImportRegistryObservation;
    return { state: { snapshot: null, registry: null, revisions: [], observation }, issues: [] };
  }
  const registryResult = steeringRegistrySchema.safeParse(input.registry);
  if (!registryResult.success) return { issues: [invalid("registry-shape")] };
  const registry = registryResult.data as SteeringRegistry;
  if (registry.project !== project || input.head.project !== project || input.head.steering_generation !== registry.generation)
    return { issues: [invalid("registry-project-or-generation")] };
  const revisions: SteeringResourceRevisionValue[] = [];
  for (const value of input.revisions) {
    const parsed = steeringResourceRevisionSchema.safeParse(value);
    if (!parsed.success) return { issues: [invalid("registry-revision-shape")] };
    revisions.push(parsed.data as SteeringResourceRevisionValue);
  }
  for (const resource of registry.resources) {
    for (const summary of resource.revisions) if (!revisions.some((revision) => exact(revision.identity, summary.identity)))
      return { issues: [invalid("registry-revision-missing", resource.id)] };
    if (resource.status === "active" && !revisions.some((revision) => exact(revision.identity, resource.current)))
      return { issues: [invalid("registry-current-missing", resource.id)] };
  }
  const observation = steeringAgentsImportRegistryObservationSchema.parse({
    status: "present",
    project,
    head: input.head,
    commit_sequence: input.head.sequence,
    steering_generation: registry.generation,
    resources: registry.resources.map((resource) => steeringExpectationFor(registry, resource.id))
      .sort((left, right) => compareText(left.id, right.id)),
  }) as SteeringAgentsImportRegistryObservation;
  return { state: { snapshot: input, registry, revisions, observation }, issues: [] };
}

function inspectionSources(input: SteeringAgentsImportPlanInput): {
  sources?: readonly InspectedAgentsImportSource[];
  issues: readonly SteeringAgentsImportIssue[];
} {
  const inspection = input.inspection;
  if (!inspection || inspection.schema !== STEERING_AGENTS_INSPECTION_SCHEMA || inspection.status !== "valid" || !inspection.complete)
    return { issues: [{ code: "agents-import-source-unsafe", detail: "inspection-not-valid" }] };
  if (!steeringProjectNamespaceSchema.safeParse(inspection.project).success)
    return { issues: [invalid("inspection-project")] };
  const sources: InspectedAgentsImportSource[] = [];
  for (const observation of inspection.observations) {
    try { sources.push({ source: agentsImportSourceFor(observation) }); }
    catch { return { issues: [{ code: "agents-import-source-unsafe", detail: "observation-invalid" }] }; }
  }
  sources.sort((left, right) => compareText(left.source.mapping.resource, right.source.mapping.resource) ||
    compareText(left.source.observation.source_path, right.source.observation.source_path));
  const resources = new Map<string, InspectedAgentsImportSource>();
  for (const source of sources) {
    const existing = resources.get(source.source.mapping.resource);
    if (existing !== undefined) return { issues: [{ code: "agents-import-resource-collision",
      resource: source.source.mapping.resource,
      source_path: source.source.observation.source_path,
      detail: `collides-with:${existing.source.observation.source_path}` }] };
    resources.set(source.source.mapping.resource, source);
  }
  return { sources, issues: [] };
}

function actionFromDraft(draft: ActionDraft): SteeringAgentsImportAction {
  const value = draft.kind === "create" ? {
    kind: "create" as const,
    resource: draft.resource,
    source: draft.source,
    comparison: draft.comparison,
    expectation: draft.expectation,
    next: draft.next!,
  } : draft.kind === "update" ? {
    kind: "update" as const,
    resource: draft.resource,
    source: draft.source,
    comparison: draft.comparison,
    expectation: draft.expectation,
    supersedes: draft.supersedes!,
    next: draft.next!,
  } : draft.kind === "unchanged" ? {
    kind: "unchanged" as const,
    resource: draft.resource,
    source: draft.source,
    comparison: draft.comparison,
    expectation: draft.expectation,
    current: draft.current!,
  } : {
    kind: "conflict" as const,
    resource: draft.resource,
    source: draft.source,
    comparison: draft.comparison,
    expectation: draft.expectation,
    issues: stableSteeringAgentsImportIssues(draft.issues),
  };
  return steeringAgentsImportActionSchema.parse({
    ...value,
    action_id: steeringAgentsImportActionId(value as SteeringAgentsImportAction),
  }) as SteeringAgentsImportAction;
}

function planningDrafts(
  state: RegistryPlanningState,
  sources: readonly InspectedAgentsImportSource[],
): { drafts?: ActionDraft[]; issues: readonly SteeringAgentsImportIssue[] } {
  const drafts: ActionDraft[] = [];
  for (const inspected of sources) {
    const source = inspected.source;
    const resource = source.mapping.resource;
    const expectation = state.registry === null ? { id: resource, status: "absent" as const } :
      steeringExpectationFor(state.registry, resource);
    if (expectation.status === "retired") {
      drafts.push({ resource, source, comparison: allChanged(), expectation, kind: "conflict", issues: [{
        code: "agents-import-mapping-conflict", resource, detail: "retired-resource-id",
      }] });
      continue;
    }
    if (expectation.status === "absent") {
      const next = nextReference(resource, source.observation.source.hash);
      if (next === undefined) {
        drafts.push({ resource, source, comparison: allChanged(), expectation, kind: "conflict", issues: [{
          code: "agents-import-mapping-conflict", resource, detail: "revision-overflow",
        }] });
        continue;
      }
      const provisional: ActionDraft = { resource, source, comparison: allChanged(), expectation,
        kind: "create", next, issues: [] };
      try {
        const action = actionFromDraft(provisional) as SteeringAgentsImportPublicationAction;
        drafts.push({ ...provisional, candidate: constructSteeringAgentsImportRevision(action, planningCreated) as SteeringResourceRevisionValue });
      } catch {
        drafts.push({ ...provisional, kind: "conflict", issues: [{
          code: "agents-import-mapping-conflict", resource, detail: "revision-construction",
        }] });
      }
      continue;
    }

    const current = state.revisions.find((revision) => exact(revision.identity, expectation.current));
    if (current === undefined) return { issues: [invalid("expected-current-revision-missing", resource)] };
    const shapeIssues = validateAgentsImportRawResource(current);
    if (shapeIssues.length) {
      drafts.push({ resource, source, comparison: allChanged(), expectation, current: expectation.current,
        kind: "conflict", issues: [...shapeIssues] });
      continue;
    }
    const next = nextReference(resource, source.observation.source.hash, expectation.current);
    if (next === undefined) {
      drafts.push({ resource, source, comparison: allChanged(), expectation, current: expectation.current,
        kind: "conflict", issues: [{ code: "agents-import-mapping-conflict", resource, detail: "revision-overflow" }] });
      continue;
    }
    const provisional: ActionDraft = { resource, source, comparison: allChanged(), expectation,
      current: expectation.current, supersedes: expectation.current, kind: "update", next, issues: [] };
    try {
      const action = actionFromDraft(provisional) as SteeringAgentsImportPublicationAction;
      const candidate = constructSteeringAgentsImportRevision(action, planningCreated) as SteeringResourceRevisionValue;
      const comparison = compareToCandidate(current, candidate);
      if (isUnchanged(comparison)) {
        drafts.push({ resource, source, comparison, expectation, current: expectation.current, kind: "unchanged", issues: [] });
      } else {
        const history = validateSteeringRevisionHistory([...state.revisions.filter((revision) => revision.identity.id === resource), candidate]);
        if (history.length) drafts.push({ ...provisional, comparison, kind: "conflict", issues: history.map((entry) => ({
          code: "agents-import-mapping-conflict" as const, resource, detail: entry.code,
        })) });
        else drafts.push({ ...provisional, comparison, candidate });
      }
    } catch {
      drafts.push({ ...provisional, kind: "conflict", issues: [{
        code: "agents-import-mapping-conflict", resource, detail: "revision-construction",
      }] });
    }
  }
  return { drafts, issues: [] };
}

function closureIssues(
  project: string,
  existing: readonly SteeringResourceRevisionValue[],
  candidates: readonly SteeringResourceRevisionValue[],
): { readonly affected: readonly SteeringAgentsImportIssue[]; readonly global: readonly SteeringAgentsImportIssue[] } {
  const all = [...existing, ...candidates];
  const affected: SteeringAgentsImportIssue[] = [], global: SteeringAgentsImportIssue[] = [];
  const push = (target: SteeringAgentsImportIssue[], resource: SteeringResourceId | undefined, detail: string): void => {
    target.push({ code: "agents-import-mapping-conflict", ...(resource === undefined ? {} : { resource }), detail });
  };
  for (const issue of validateSteeringRevisionHistory(all)) {
    const candidate = candidates.find((entry) => issue.subject?.startsWith(`${entry.identity.id}@`) || issue.subject === entry.identity.id);
    push(candidate === undefined ? global : affected, candidate?.identity.id, issue.code);
  }
  for (const issue of validateSteeringHierarchy(all, project).issues) {
    const candidate = issue.resource === undefined ? undefined : candidates.find((entry) => exact(entry.identity, issue.resource));
    push(candidate === undefined ? global : affected, candidate?.identity.id,
      `${issue.code}${issue.detail === undefined ? "" : `:${issue.detail}`}`);
  }
  return {
    affected: stableSteeringAgentsImportIssues(affected),
    global: stableSteeringAgentsImportIssues(global),
  };
}

/** Pure resulting-registry closure validation. It never resolves guidance prose. */
export function validateSteeringAgentsImportCandidateClosure(
  project: string,
  existing: readonly SteeringResourceRevisionValue[],
  candidates: readonly SteeringResourceRevisionValue[],
): readonly SteeringAgentsImportIssue[] {
  const result = closureIssues(project, existing, candidates);
  return stableSteeringAgentsImportIssues([...result.affected, ...result.global]);
}

function excludeInvalidClosure(project: string, state: RegistryPlanningState, drafts: ActionDraft[]): readonly SteeringAgentsImportIssue[] {
  for (;;) {
    const candidates = drafts.filter((draft): draft is ActionDraft & { candidate: SteeringResourceRevisionValue } =>
      (draft.kind === "create" || draft.kind === "update") && draft.candidate !== undefined).map((draft) => draft.candidate);
    const closure = closureIssues(project, state.revisions, candidates);
    if (closure.global.length) return closure.global;
    if (!closure.affected.length) return [];
    const byResource = new Map<string, SteeringAgentsImportIssue[]>();
    for (const issue of closure.affected) if (issue.resource !== undefined) {
      const values = byResource.get(issue.resource) ?? [];
      values.push(issue); byResource.set(issue.resource, values);
    }
    for (const draft of drafts) {
      const issues = byResource.get(draft.resource);
      if (!issues || (draft.kind !== "create" && draft.kind !== "update")) continue;
      draft.kind = "conflict";
      draft.issues = stableSteeringAgentsImportIssues([...draft.issues, ...issues]);
    }
  }
}

function selectionFor(
  input: SteeringAgentsImportPlanInput,
  actions: readonly SteeringAgentsImportAction[],
  state: RegistryPlanningState,
): { selection?: readonly string[]; issues: readonly SteeringAgentsImportIssue[] } {
  const byPath = new Map(actions.map((action) => [action.source.observation.source_path, action]));
  let selected: SteeringAgentsImportAction[];
  if (input.selection === undefined) selected = actions.filter((action) => action.kind !== "conflict");
  else {
    const paths: string[] = [];
    for (const value of input.selection) {
      const parsed = agentsSourcePathSchema.safeParse(value);
      if (!parsed.success) return { issues: [{ code: "agents-import-partial-selection-invalid", detail: "invalid-source-selection" }] };
      paths.push(parsed.data);
    }
    if (new Set(paths).size !== paths.length)
      return { issues: [{ code: "agents-import-partial-selection-invalid", detail: "duplicate-source-selection" }] };
    selected = [];
    for (const path of paths) {
      const action = byPath.get(path);
      if (action === undefined || action.kind === "conflict") return { issues: [{
        code: "agents-import-partial-selection-invalid", source_path: path, detail: "unavailable-action",
      }] };
      selected.push(action);
    }
  }
  const candidates = selected.filter((action): action is SteeringAgentsImportPublicationAction =>
    action.kind === "create" || action.kind === "update").map((action) =>
    constructSteeringAgentsImportRevision(action, planningCreated) as SteeringResourceRevisionValue);
  const closure = validateSteeringAgentsImportCandidateClosure(state.observation.project, state.revisions, candidates);
  if (closure.length) return { issues: closure.map((issue) => ({
    ...issue,
    code: "agents-import-partial-selection-invalid" as const,
  })) };
  return { selection: selected.map((action) => action.action_id).sort(compareText), issues: [] };
}

/**
 * Read-only deterministic planning from exact 05C-4B1 observations and exact
 * Steering authority. It neither publishes blobs nor creates registry state.
 */
export function planSteeringAgentsImport(input: SteeringAgentsImportPlanInput): SteeringAgentsImportPlanResult {
  const inspected = inspectionSources(input);
  if (inspected.issues.length || inspected.sources === undefined) return failure(inspected.issues);
  const project = input.inspection.project;
  if (!steeringProjectNamespaceSchema.safeParse(project).success) return failure([invalid("project")]);
  const stateResult = registryState(input.registry, project);
  if (stateResult.issues.length || stateResult.state === undefined) return failure(stateResult.issues);
  const state = stateResult.state;
  const draftsResult = planningDrafts(state, inspected.sources);
  if (draftsResult.issues.length || draftsResult.drafts === undefined) return failure(draftsResult.issues);
  const global = excludeInvalidClosure(project, state, draftsResult.drafts);
  if (global.length) return failure(global);
  const actions = draftsResult.drafts.map(actionFromDraft).sort((left, right) => compareText(left.resource, right.resource));
  const selected = selectionFor(input, actions, state);
  if (selected.issues.length || selected.selection === undefined) return failure(selected.issues);

  const base = {
    schema: STEERING_AGENTS_IMPORT_PLAN_SCHEMA,
    project,
    control: { root: "." as const },
    discovery: {
      policy: "aira.dev/steering-agents-discovery/v1" as const,
      observation_schema: "aira.dev/steering-agents-observation/v1" as const,
    },
    policy: agentsImportPolicy,
    registry: state.observation,
    actions,
    selection: { action_ids: selected.selection },
    authorization: {
      required: true as const,
      contract: "aira.dev/steering-agents-import-authorization/v1" as const,
      actor_kind: "human" as const,
      worker_self_modification: "forbidden" as const,
    },
    operation: {
      required: true as const,
      contract: "aira.dev/steering-agents-import-operation/v1" as const,
      storage_idempotency: "steering-store-operation-id/v1" as const,
    },
  };
  const placeholder = {
    ...base,
    id: "steering_agents_import_plan_000000000000000000000000000000000000000000000000000000000000",
    hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  } as unknown as SteeringAgentsImportPlan;
  const hash = steeringAgentsImportPlanHash(placeholder);
  const plan = steeringAgentsImportPlanSchema.parse({
    ...base,
    id: steeringAgentsImportPlanIdFromHash(hash),
    hash,
  }) as SteeringAgentsImportPlan;
  return { ok: true, plan: freezeSteeringAgentsImport(plan) };
}

export const buildSteeringAgentsImportPlan = planSteeringAgentsImport;
export const createSteeringAgentsImportPlan = planSteeringAgentsImport;

/** Convenience read-only adapter: inspect AGENTS, load authority, then construct a detached plan. */
export async function inspectAndPlanSteeringAgentsImport(
  input: InspectAndPlanSteeringAgentsImportInput,
): Promise<SteeringAgentsImportPlanResult> {
  const inspection = await inspectAgentsInterop(input.project_root, { project: input.project });
  let registry: SteeringStoreSnapshot | null;
  try { registry = await input.store.loadRegistry(input.project as never); }
  catch (error) {
    if (error instanceof StorageError && error.code === "STORE_NOT_FOUND") registry = null;
    else throw error;
  }
  return planSteeringAgentsImport({ inspection, registry, selection: input.selection });
}

export const planAgentsInteropImport = inspectAndPlanSteeringAgentsImport;

/** Construct the ordinary next registry state for selected raw AGENTS publications. */
export function registryAfterSteeringAgentsImport(
  previous: SteeringRegistry | null,
  project: string,
  publications: readonly SteeringResourceRevisionValue[],
): SteeringRegistry {
  const resources = previous === null ? [] : previous.resources.map((resource) => ({ ...resource, revisions: [...resource.revisions] }));
  for (const revision of publications) {
    const id = revision.identity.id;
    const summary = steeringRegistryRevisionOf(revision);
    const index = resources.findIndex((resource) => resource.id === id);
    if (index < 0) resources.push({ id, status: "active" as const, current: revision.identity, revisions: [summary] });
    else {
      const current = resources[index]!;
      if (current.status !== "active") throw new Error(`Retired Steering resource cannot be reused: ${id}`);
      resources[index] = { ...current, current: revision.identity, revisions: [...current.revisions, summary] };
    }
  }
  resources.sort((left, right) => compareText(left.id, right.id));
  return steeringRegistrySchema.parse({
    schema: "aira.dev/steering-registry/v1",
    project,
    generation: previous === null ? "0" : (BigInt(previous.generation) + 1n).toString(),
    resources,
  }) as SteeringRegistry;
}
