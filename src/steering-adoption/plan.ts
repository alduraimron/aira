import { hashCanonical } from "../canonical-json";
import { operationIdSchema } from "../spec/domain/ids";
import { compareText, exact } from "../spec/domain/primitives";
import {
  steeringResourceIdSchema,
  steeringRevisionIdSchema,
  type SteeringResourceId,
  type SteeringRevisionReference,
} from "../steering/ids";
import { validateSteeringHierarchy } from "../steering/hierarchy";
import { validateSteeringRevisionHistory } from "../steering/resources";
import {
  steeringNativeSourceAttributionSchema,
  steeringProjectNamespaceSchema,
  steeringProvenanceSchema,
  steeringResourceRevisionSchema,
  type SteeringResourceRevisionValue,
} from "../steering/schema";
import type { SteeringProvenance } from "../steering/types";
import { inspectNativeSteering, type SteeringSourceParseSuccess } from "../steering-source";
import { renderNativeSteeringSource } from "../steering-materialization/render";
import { StorageError } from "../storage/errors";
import { type SteeringStore } from "../storage/steering-store";
import {
  steeringExpectationFor,
  steeringRegistryRevisionOf,
  steeringRegistrySchema,
  type SteeringRegistry,
  type SteeringResourceExpectation,
  type SteeringStoreSnapshot,
} from "../storage/steering-types";
import {
  STEERING_ADOPTION_PLAN_SCHEMA,
  freezeSteeringAdoption,
  steeringAdoptionActionId,
  steeringAdoptionActionSchema,
  steeringAdoptionPlanHash,
  steeringAdoptionPlanIdFromHash,
  steeringAdoptionProvenanceSemantic,
  steeringAdoptionPlanSchema,
  steeringAdoptionRegistryObservationSchema,
  steeringAdoptionSourceSchema,
  stableSteeringAdoptionIssues,
  type InspectAndPlanSteeringAdoptionInput,
  type SteeringAdoptionAction,
  type SteeringAdoptionComparison,
  type SteeringAdoptionIssue,
  type SteeringAdoptionPlan,
  type SteeringAdoptionPlanInput,
  type SteeringAdoptionPlanResult,
  type SteeringAdoptionPublicationAction,
  type SteeringAdoptionRegistryObservation,
  type SteeringAdoptionSource,
} from "./types";

const planningCreated = {
  at: "1970-01-01T00:00:00.000Z",
  by: { kind: "human", id: "steering-adoption-plan" },
  operation: operationIdSchema.parse("operation_steering-adoption-plan"),
  channel: "api",
} as const;

interface RegistryPlanningState {
  readonly snapshot: SteeringStoreSnapshot | null;
  readonly registry: SteeringRegistry | null;
  readonly revisions: readonly SteeringResourceRevisionValue[];
  readonly observation: SteeringAdoptionRegistryObservation;
}

interface InspectedAdoptionSource {
  readonly source: SteeringAdoptionSource;
  readonly parsed: SteeringSourceParseSuccess;
}

interface ActionDraft {
  readonly resource: SteeringResourceId;
  readonly source: SteeringAdoptionSource;
  readonly comparison: SteeringAdoptionComparison;
  readonly expectation: SteeringResourceExpectation;
  kind: "create" | "update" | "unchanged" | "conflict";
  readonly current?: SteeringRevisionReference;
  readonly next?: SteeringRevisionReference;
  readonly supersedes?: SteeringRevisionReference;
  readonly candidate?: SteeringResourceRevisionValue;
  issues: SteeringAdoptionIssue[];
}

function planFailure(issues: readonly SteeringAdoptionIssue[]): SteeringAdoptionPlanResult {
  return { ok: false, issues: freezeSteeringAdoption(stableSteeringAdoptionIssues(issues)) };
}

function invalidPlan(detail: string, resource?: SteeringResourceId): SteeringAdoptionIssue {
  return { code: "adoption-plan-invalid", ...(resource === undefined ? {} : { resource }), detail };
}

function changed(): SteeringAdoptionComparison {
  return { body: "changed", metadata: "changed", rules: "changed", provenance: "changed" };
}

function sameRuleMeaning(rule: unknown): unknown {
  const value = rule as { source?: { location: unknown }; [key: string]: unknown };
  const { source, ...rest } = value;
  return source === undefined ? rest : { ...rest, source: { location: source.location } };
}

function resourceMetadataMeaning(value: {
  readonly kind: unknown;
  readonly custom_kind?: unknown;
  readonly layer: unknown;
  readonly content_encoding: unknown;
  readonly default_authority: unknown;
  readonly default_override_policy: unknown;
  readonly default_enforcement: unknown;
  readonly inclusion: unknown;
  readonly scope: unknown;
  readonly composition: unknown;
  readonly compatibility: unknown;
  readonly metadata: unknown;
  readonly behavioral_assets: unknown;
}): unknown {
  return {
    kind: value.kind,
    ...(value.custom_kind === undefined ? {} : { custom_kind: value.custom_kind }),
    layer: value.layer,
    content_encoding: value.content_encoding,
    default_authority: value.default_authority,
    default_override_policy: value.default_override_policy,
    default_enforcement: value.default_enforcement,
    inclusion: value.inclusion,
    scope: value.scope,
    composition: value.composition,
    compatibility: value.compatibility,
    metadata: value.metadata,
    behavioral_assets: value.behavioral_assets,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A byte-exact canonical authority projection is already represented by the
 * current revision. Re-adopting it must not manufacture a source-lineage-only
 * successor revision. Any human byte change fails this exact check.
 */
function canonicalMaterializedProjection(
  project: string,
  source: SteeringSourceParseSuccess,
  current: SteeringResourceRevisionValue,
): boolean {
  const rendered = renderNativeSteeringSource({
    project,
    target_path: source.observation.source_path,
    revision: current,
    body: source.body_bytes,
  });
  return rendered.ok && sameBytes(rendered.bytes, source.source_bytes);
}

function compareSourceToRevision(
  source: SteeringAdoptionSource,
  current: SteeringResourceRevisionValue,
  canonicalProjection = false,
): SteeringAdoptionComparison {
  const proposal = source.proposal;
  return {
    body: exact(current.content, proposal.content) && current.identity.hash === proposal.identity.body_hash ? "unchanged" : "changed",
    metadata: exact(resourceMetadataMeaning(current), resourceMetadataMeaning(proposal)) ? "unchanged" : "changed",
    rules: exact(current.rules.map(sameRuleMeaning), proposal.rules.map(sameRuleMeaning)) ? "unchanged" : "changed",
    provenance: canonicalProjection || exact(steeringAdoptionProvenanceSemantic(current.provenance),
      steeringAdoptionProvenanceSemantic(source.authoritative_provenance)) ? "unchanged" : "changed",
  };
}

function unchanged(comparison: SteeringAdoptionComparison): boolean {
  return comparison.body === "unchanged" && comparison.metadata === "unchanged" &&
    comparison.rules === "unchanged" && comparison.provenance === "unchanged";
}

function nativeAuthoritativeProvenance(source: SteeringSourceParseSuccess): SteeringProvenance {
  const native = steeringNativeSourceAttributionSchema.parse(source.observation);
  if (source.proposal.provenance.kind !== "project") throw new Error("native project proposal must retain project provenance");
  return steeringProvenanceSchema.parse({ ...source.proposal.provenance, native_source: native }) as SteeringProvenance;
}

function adoptionSource(source: SteeringSourceParseSuccess): SteeringAdoptionSource {
  return steeringAdoptionSourceSchema.parse({
    observation: source.observation,
    proposal: source.proposal,
    authoritative_provenance: nativeAuthoritativeProvenance(source),
  }) as SteeringAdoptionSource;
}

function nextRevision(reference: SteeringRevisionReference): SteeringRevisionReference | undefined {
  const next = BigInt(reference.revision) + 1n;
  if (next > 18_446_744_073_709_551_615n) return undefined;
  return {
    id: reference.id,
    revision: steeringRevisionIdSchema.parse(next.toString()),
    hash: reference.hash,
  };
}

function nextReference(resource: SteeringResourceId, bodyHash: SteeringRevisionReference["hash"], current?: SteeringRevisionReference): SteeringRevisionReference | undefined {
  if (current === undefined) return {
    id: resource,
    revision: steeringRevisionIdSchema.parse("1"),
    hash: bodyHash,
  };
  const next = nextRevision(current);
  return next === undefined ? undefined : { ...next, hash: bodyHash };
}

/** Construct one valid revision from a plan action without inventing a second revision model. */
export function constructSteeringAdoptionRevision(
  action: SteeringAdoptionPublicationAction,
  created: SteeringResourceRevisionValue["created"],
): SteeringResourceRevisionValue {
  const proposal = action.source.proposal;
  return steeringResourceRevisionSchema.parse({
    schema: "aira.dev/steering-resource/v1",
    identity: action.next,
    kind: proposal.kind,
    ...(proposal.custom_kind === undefined ? {} : { custom_kind: proposal.custom_kind }),
    layer: proposal.layer,
    provenance: action.source.authoritative_provenance,
    content: proposal.content,
    content_encoding: proposal.content_encoding,
    default_authority: proposal.default_authority,
    default_override_policy: proposal.default_override_policy,
    default_enforcement: proposal.default_enforcement,
    inclusion: proposal.inclusion,
    scope: proposal.scope,
    rules: proposal.rules,
    composition: proposal.composition,
    compatibility: proposal.compatibility,
    metadata: proposal.metadata,
    created,
    behavioral_assets: proposal.behavioral_assets,
    ...(action.kind === "update" ? { supersedes: action.supersedes } : {}),
  }) as SteeringResourceRevisionValue;
}

function registryState(input: SteeringStoreSnapshot | null, project: string): { state?: RegistryPlanningState; issues: SteeringAdoptionIssue[] } {
  if (input === null) {
    const observation = steeringAdoptionRegistryObservationSchema.parse({ status: "absent", project }) as SteeringAdoptionRegistryObservation;
    return { state: { snapshot: null, registry: null, revisions: [], observation }, issues: [] };
  }
  const registryResult = steeringRegistrySchema.safeParse(input.registry);
  if (!registryResult.success) return { issues: [invalidPlan("registry-shape")] };
  const registry = registryResult.data;
  if (registry.project !== project || input.head.project !== project || input.head.steering_generation !== registry.generation)
    return { issues: [invalidPlan("registry-project-or-generation")] };
  const revisions: SteeringResourceRevisionValue[] = [];
  for (const value of input.revisions) {
    const parsed = steeringResourceRevisionSchema.safeParse(value);
    if (!parsed.success) return { issues: [invalidPlan("registry-revision-shape")] };
    revisions.push(parsed.data as SteeringResourceRevisionValue);
  }
  for (const resource of registry.resources) {
    for (const summary of resource.revisions) if (!revisions.some((revision) => exact(revision.identity, summary.identity)))
      return { issues: [invalidPlan("registry-revision-missing", resource.id)] };
    if (resource.status === "active" && !revisions.some((revision) => exact(revision.identity, resource.current)))
      return { issues: [invalidPlan("registry-current-missing", resource.id)] };
  }
  const expectations = registry.resources.map((resource) => steeringExpectationFor(registry, resource.id))
    .sort((left, right) => compareText(left.id, right.id));
  const observation = steeringAdoptionRegistryObservationSchema.parse({
    status: "present",
    project,
    head: input.head,
    commit_sequence: input.head.sequence,
    steering_generation: registry.generation,
    resources: expectations,
  }) as SteeringAdoptionRegistryObservation;
  return { state: { snapshot: input, registry, revisions, observation }, issues: [] };
}

function inspectionSources(input: SteeringAdoptionPlanInput): { sources?: InspectedAdoptionSource[]; issues: SteeringAdoptionIssue[] } {
  const inspection = input.inspection;
  if (!inspection || inspection.schema !== "aira.dev/steering-native-inspection/v1" || inspection.status !== "valid" || !inspection.complete)
    return { issues: [{ code: "adoption-source-unsafe", detail: "inspection-not-valid" }] };
  if (!steeringProjectNamespaceSchema.safeParse(inspection.project).success)
    return { issues: [invalidPlan("inspection-project")] };
  const sources: InspectedAdoptionSource[] = [];
  for (const proposal of inspection.proposals) {
    try { sources.push({ source: adoptionSource(proposal), parsed: proposal }); }
    catch { return { issues: [invalidPlan("inspection-proposal")] }; }
  }
  sources.sort((left, right) => compareText(left.source.observation.identity.id, right.source.observation.identity.id) ||
    compareText(left.source.observation.source_path, right.source.observation.source_path));
  if (sources.some((source, index) => index > 0 && source.source.observation.identity.id === sources[index - 1]!.source.observation.identity.id))
    return { issues: [{ code: "adoption-source-unsafe", detail: "duplicate-resource-id" }] };
  return { sources, issues: [] };
}

function directCandidateClosureIssues(
  project: string,
  existing: readonly SteeringResourceRevisionValue[],
  candidates: readonly SteeringResourceRevisionValue[],
): { readonly issues: readonly SteeringAdoptionIssue[]; readonly global: readonly SteeringAdoptionIssue[] } {
  const all = [...existing, ...candidates];
  const has = (reference: SteeringRevisionReference): boolean => all.some((revision) => exact(revision.identity, reference));
  const issues: SteeringAdoptionIssue[] = [], global: SteeringAdoptionIssue[] = [];
  for (const candidate of candidates) {
    const resource = candidate.identity.id;
    for (const parent of candidate.composition.parents) if (!has(parent))
      issues.push({ code: "adoption-cross-reference-invalid", resource, detail: `parent:${parent.id}@${parent.revision}` });
    for (const override of candidate.composition.overrides) {
      const target = all.find((revision) => exact(revision.identity, override.target.resource));
      if (!target) issues.push({ code: "adoption-cross-reference-invalid", resource,
        detail: `override-resource:${override.target.resource.id}@${override.target.resource.revision}` });
      else if (override.target.rule !== undefined && !target.rules.some((rule) => rule.id === override.target.rule))
        issues.push({ code: "adoption-cross-reference-invalid", resource, detail: `override-rule:${override.target.rule}` });
    }
    if (candidate.provenance.kind === "project" && candidate.provenance.adopted_from?.kind === "steering-revision" &&
      !has(candidate.provenance.adopted_from.revision))
      issues.push({ code: "adoption-cross-reference-invalid", resource,
        detail: `adopted-from:${candidate.provenance.adopted_from.revision.id}@${candidate.provenance.adopted_from.revision.revision}` });
  }
  const history = validateSteeringRevisionHistory(all);
  for (const issue of history) {
    const resource = candidates.find((candidate) => issue.subject?.startsWith(`${candidate.identity.id}@`) || issue.subject === candidate.identity.id);
    if (resource) issues.push({ code: "adoption-resource-conflict", resource: resource.identity.id, detail: issue.code });
    else global.push({ code: "adoption-resource-conflict", detail: issue.code });
  }
  const hierarchy = validateSteeringHierarchy(all, project);
  for (const issue of hierarchy.issues) {
    const resource = issue.resource && candidates.find((candidate) => exact(candidate.identity, issue.resource));
    if (resource) issues.push({ code: "adoption-cross-reference-invalid", resource: resource.identity.id,
      detail: `${issue.code}${issue.detail === undefined ? "" : `:${issue.detail}`}` });
    else global.push({ code: "adoption-cross-reference-invalid",
      ...(issue.resource === undefined ? {} : { resource: issue.resource.id }),
      detail: `${issue.code}${issue.detail === undefined ? "" : `:${issue.detail}`}` });
  }
  return { issues: stableSteeringAdoptionIssues(issues), global: stableSteeringAdoptionIssues(global) };
}

/** Pure integrity check for the resulting registry revision closure. It never resolves Steering. */
export function validateSteeringAdoptionCandidateClosure(
  project: string,
  existing: readonly SteeringResourceRevisionValue[],
  candidates: readonly SteeringResourceRevisionValue[],
): readonly SteeringAdoptionIssue[] {
  const result = directCandidateClosureIssues(project, existing, candidates);
  return stableSteeringAdoptionIssues([...result.issues, ...result.global]);
}

function actionFromDraft(draft: ActionDraft): SteeringAdoptionAction {
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
    issues: stableSteeringAdoptionIssues(draft.issues),
  };
  const actionId = steeringAdoptionActionId(value as SteeringAdoptionAction);
  return steeringAdoptionActionSchema.parse({ ...value, action_id: actionId }) as SteeringAdoptionAction;
}

function references(candidate: SteeringResourceRevisionValue): SteeringRevisionReference[] {
  const result = [
    ...candidate.composition.parents,
    ...candidate.composition.overrides.map((override) => override.target.resource),
  ];
  if (candidate.provenance.kind === "project" && candidate.provenance.adopted_from?.kind === "steering-revision")
    result.push(candidate.provenance.adopted_from.revision);
  return result;
}

function selectedDependencyIssues(
  existing: readonly SteeringResourceRevisionValue[],
  selected: readonly SteeringResourceRevisionValue[],
  allCandidates: readonly SteeringResourceRevisionValue[],
): SteeringAdoptionIssue[] {
  const available = [...existing, ...selected];
  const has = (reference: SteeringRevisionReference): boolean => available.some((revision) => exact(revision.identity, reference));
  const issues: SteeringAdoptionIssue[] = [];
  for (const candidate of selected) for (const reference of references(candidate)) if (!has(reference) &&
    allCandidates.some((other) => exact(other.identity, reference)))
    issues.push({ code: "adoption-partial-selection-invalid", resource: candidate.identity.id,
      detail: `omitted-dependency:${reference.id}@${reference.revision}` });
  return stableSteeringAdoptionIssues(issues);
}

function planningDrafts(
  state: RegistryPlanningState,
  project: string,
  sources: readonly InspectedAdoptionSource[],
): { drafts?: ActionDraft[]; issues: SteeringAdoptionIssue[] } {
  const drafts: ActionDraft[] = [];
  for (const inspected of sources) {
    const source = inspected.source;
    const resource = source.observation.identity.id;
    const expectation = state.registry === null ? { id: resource, status: "absent" as const } : steeringExpectationFor(state.registry, resource);
    if (expectation.status === "retired") {
      drafts.push({ resource, source, comparison: changed(), expectation, kind: "conflict", issues: [{
        code: "adoption-retired-id-reuse", resource, detail: "retired-resource-id",
      }] });
      continue;
    }
    if (expectation.status === "absent") {
      const next = nextReference(resource, source.proposal.content.hash);
      if (next === undefined) {
        drafts.push({ resource, source, comparison: changed(), expectation, kind: "conflict", issues: [{
          code: "adoption-resource-conflict", resource, detail: "revision-overflow",
        }] });
        continue;
      }
      const provisional = { resource, source, comparison: changed(), expectation, kind: "create" as const, next, issues: [] as SteeringAdoptionIssue[] };
      try {
        const action = actionFromDraft(provisional);
        drafts.push({ ...provisional, candidate: constructSteeringAdoptionRevision(action as SteeringAdoptionPublicationAction, planningCreated) });
      } catch {
        drafts.push({ ...provisional, kind: "conflict", issues: [{ code: "adoption-resource-conflict", resource, detail: "revision-construction" }] });
      }
      continue;
    }
    const current = state.revisions.find((revision) => exact(revision.identity, expectation.current));
    if (current === undefined) return { issues: [invalidPlan("expected-current-revision-missing", resource)] };
    const comparison = compareSourceToRevision(source, current,
      canonicalMaterializedProjection(project, inspected.parsed, current));
    if (unchanged(comparison)) {
      drafts.push({ resource, source, comparison, expectation, current: expectation.current, kind: "unchanged", issues: [] });
      continue;
    }
    const next = nextReference(resource, source.proposal.content.hash, expectation.current);
    if (next === undefined) {
      drafts.push({ resource, source, comparison, expectation, current: expectation.current, kind: "conflict", issues: [{
        code: "adoption-resource-conflict", resource, detail: "revision-overflow",
      }] });
      continue;
    }
    const provisional = { resource, source, comparison, expectation, current: expectation.current,
      supersedes: expectation.current, kind: "update" as const, next, issues: [] as SteeringAdoptionIssue[] };
    try {
      const action = actionFromDraft(provisional);
      const candidate = constructSteeringAdoptionRevision(action as SteeringAdoptionPublicationAction, planningCreated);
      const history = validateSteeringRevisionHistory([...state.revisions.filter((revision) => revision.identity.id === resource), candidate]);
      if (history.length) {
        drafts.push({ ...provisional, kind: "conflict", issues: history.map((issue) => ({
          code: "adoption-resource-conflict" as const, resource, detail: issue.code,
        })) });
      } else drafts.push({ ...provisional, candidate });
    } catch {
      drafts.push({ ...provisional, kind: "conflict", issues: [{ code: "adoption-resource-conflict", resource, detail: "revision-construction" }] });
    }
  }
  return { drafts, issues: [] };
}

function excludeInvalidCrossReferences(project: string, state: RegistryPlanningState, drafts: ActionDraft[]): SteeringAdoptionIssue[] {
  for (;;) {
    const candidates = drafts.filter((draft): draft is ActionDraft & { candidate: SteeringResourceRevisionValue } =>
      (draft.kind === "create" || draft.kind === "update") && draft.candidate !== undefined).map((draft) => draft.candidate);
    const closure = directCandidateClosureIssues(project, state.revisions, candidates);
    if (closure.global.length) return [...closure.global];
    const byResource = new Map<string, SteeringAdoptionIssue[]>();
    for (const issue of closure.issues) if (issue.resource !== undefined) {
      const values = byResource.get(issue.resource) ?? [];
      values.push(issue); byResource.set(issue.resource, values);
    }
    if (byResource.size === 0) return [];
    for (const draft of drafts) {
      const issues = byResource.get(draft.resource);
      if (!issues || (draft.kind !== "create" && draft.kind !== "update")) continue;
      draft.kind = "conflict";
      draft.issues = stableSteeringAdoptionIssues([...draft.issues, ...issues]);
    }
  }
}

function selectionFor(
  input: SteeringAdoptionPlanInput,
  actions: readonly SteeringAdoptionAction[],
  state: RegistryPlanningState,
  drafts: readonly ActionDraft[],
): { selection?: readonly string[]; issues: SteeringAdoptionIssue[] } {
  const byResource = new Map(actions.map((action) => [action.resource, action]));
  let selected: SteeringAdoptionAction[];
  if (input.selection === undefined) selected = actions.filter((action) => action.kind !== "conflict");
  else {
    const resources: SteeringResourceId[] = [];
    for (const value of input.selection) {
      const parsed = steeringResourceIdSchema.safeParse(value);
      if (!parsed.success) return { issues: [{ code: "adoption-partial-selection-invalid", detail: "invalid-resource-selection" }] };
      resources.push(parsed.data);
    }
    if (new Set(resources).size !== resources.length)
      return { issues: [{ code: "adoption-partial-selection-invalid", detail: "duplicate-resource-selection" }] };
    selected = [];
    for (const resource of resources) {
      const action = byResource.get(resource);
      if (!action || action.kind === "conflict") return { issues: [{ code: "adoption-partial-selection-invalid", resource, detail: "unavailable-action" }] };
      selected.push(action);
    }
  }
  const selectedCandidates = selected.filter((action): action is SteeringAdoptionPublicationAction =>
    action.kind === "create" || action.kind === "update").map((action) =>
    constructSteeringAdoptionRevision(action, planningCreated));
  const allCandidates = drafts.filter((draft): draft is ActionDraft & { candidate: SteeringResourceRevisionValue } =>
    (draft.kind === "create" || draft.kind === "update") && draft.candidate !== undefined).map((draft) => draft.candidate);
  const partial = selectedDependencyIssues(state.revisions, selectedCandidates, allCandidates);
  if (partial.length) return { issues: partial };
  const closure = validateSteeringAdoptionCandidateClosure(state.observation.project, state.revisions, selectedCandidates);
  if (closure.length) return { issues: closure.map((issue) => ({
    ...issue,
    code: issue.code === "adoption-cross-reference-invalid" ? "adoption-cross-reference-invalid" : "adoption-resource-conflict",
  })) };
  return { selection: selected.map((action) => action.action_id).sort(compareText), issues: [] };
}

/**
 * Read-only deterministic comparison of one complete native inspection and one
 * exact registry observation. It neither reads files nor mutates storage.
 */
export function planSteeringAdoption(input: SteeringAdoptionPlanInput): SteeringAdoptionPlanResult {
  const inspection = inspectionSources(input);
  if (inspection.issues.length || inspection.sources === undefined) return planFailure(inspection.issues);
  const project = input.inspection.project;
  if (!steeringProjectNamespaceSchema.safeParse(project).success) return planFailure([invalidPlan("project")]);
  const stateResult = registryState(input.registry, project);
  if (stateResult.issues.length || stateResult.state === undefined) return planFailure(stateResult.issues);
  const state = stateResult.state;
  const draftResult = planningDrafts(state, project, inspection.sources);
  if (draftResult.issues.length || draftResult.drafts === undefined) return planFailure(draftResult.issues);
  const global = excludeInvalidCrossReferences(project, state, draftResult.drafts);
  if (global.length) return planFailure(global);
  const actions = draftResult.drafts.map(actionFromDraft).sort((left, right) => compareText(left.resource, right.resource));
  const selected = selectionFor(input, actions, state, draftResult.drafts);
  if (selected.issues.length || selected.selection === undefined) return planFailure(selected.issues);

  const base = {
    schema: STEERING_ADOPTION_PLAN_SCHEMA,
    project,
    control: { steering_root: ".aira/steering" as const },
    discovery: {
      policy: "aira.dev/steering-discovery/native/v1" as const,
      source_schema: "aira.dev/steering-source/v1" as const,
      observation_schema: "aira.dev/steering-source-observation/v1" as const,
    },
    registry: state.observation,
    actions,
    selection: { action_ids: selected.selection },
    authorization: {
      required: true as const,
      contract: "aira.dev/steering-adoption-authorization/v1" as const,
      actor_kind: "human" as const,
      worker_self_modification: "forbidden" as const,
    },
    operation: {
      required: true as const,
      contract: "aira.dev/steering-adoption-operation/v1" as const,
      storage_idempotency: "steering-store-operation-id/v1" as const,
    },
  };
  const placeholder = {
    ...base,
    id: "steering_adoption_plan_0000000000000000000000000000000000000000000000000000000000000000",
    hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  } as unknown as SteeringAdoptionPlan;
  const hash = steeringAdoptionPlanHash(placeholder);
  const plan = steeringAdoptionPlanSchema.parse({ ...base, id: steeringAdoptionPlanIdFromHash(hash), hash }) as SteeringAdoptionPlan;
  return { ok: true, plan: freezeSteeringAdoption(plan) };
}

/** Compatibility aliases for callers that name planning as construction. */
export const buildSteeringAdoptionPlan = planSteeringAdoption;
export const createSteeringAdoptionPlan = planSteeringAdoption;

/**
 * Convenience application boundary: inspect read-only, load current authority,
 * then build a detached plan. No lock is held while the plan is reviewed.
 */
export async function inspectAndPlanSteeringAdoption(input: InspectAndPlanSteeringAdoptionInput): Promise<SteeringAdoptionPlanResult> {
  const inspection = await inspectNativeSteering(input.project_root, { project: input.project });
  let registry: SteeringStoreSnapshot | null;
  try { registry = await input.store.loadRegistry(input.project as never); }
  catch (error) {
    if (error instanceof StorageError && error.code === "STORE_NOT_FOUND") registry = null;
    else throw error;
  }
  return planSteeringAdoption({ inspection, registry, selection: input.selection });
}

export const planNativeSteeringAdoption = inspectAndPlanSteeringAdoption;

/** Builds a registry with selected revision publications for application preflight. */
export function registryAfterSteeringAdoption(
  previous: SteeringRegistry | null,
  project: string,
  publications: readonly SteeringResourceRevisionValue[],
): SteeringRegistry {
  const byResource = new Map(publications.map((revision) => [revision.identity.id, revision]));
  const resources = previous === null ? [] : previous.resources.map((resource) => ({ ...resource, revisions: [...resource.revisions] }));
  for (const [id, revision] of byResource) {
    const summary = steeringRegistryRevisionOf(revision);
    const index = resources.findIndex((resource) => resource.id === id);
    if (index < 0) resources.push({ id, status: "active" as const, current: revision.identity, revisions: [summary] });
    else {
      const current = resources[index]!;
      if (current.status !== "active") throw new Error(`retired Steering resource cannot be reused: ${id}`);
      resources[index] = { ...current, current: revision.identity, revisions: [...current.revisions, summary] };
    }
  }
  resources.sort((left, right) => compareText(left.id, right.id));
  return steeringRegistrySchema.parse({
    schema: "aira.dev/steering-registry/v1",
    project,
    generation: previous === null ? "0" : (BigInt(previous.generation) + 1n).toString(),
    resources,
  });
}
