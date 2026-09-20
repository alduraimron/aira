import { hashBytes, hashCanonical } from "../canonical-json";
import { operationIdSchema } from "../spec/domain/ids";
import { compareText, exact } from "../spec/domain/primitives";
import {
  agentsObservationBytes,
  inspectAgentsInterop,
  type AgentsObservation,
} from "../steering-agents";
import { steeringProjectNamespaceSchema } from "../steering/schema";
import { StorageError } from "../storage/errors";
import type { SteeringStore } from "../storage/steering-store";
import {
  steeringExpectationFor,
  steeringTransactionSchema,
  type SteeringStoreSnapshot,
  type SteeringTransactionResult,
} from "../storage/steering-types";
import {
  agentsImportObservationFor,
  agentsImportSourceFor,
  compareAgentsImportObservation,
  constructSteeringAgentsImportRevision,
} from "./mapping";
import {
  registryAfterSteeringAgentsImport,
  validateSteeringAgentsImportCandidateClosure,
} from "./plan";
import {
  STEERING_AGENTS_IMPORT_RESULT_SCHEMA,
  freezeSteeringAgentsImport,
  stableSteeringAgentsImportIssues,
  steeringAgentsImportAuthorizationSchema,
  steeringAgentsImportRegistryObservationSchema,
  steeringAgentsImportResultSchema,
  validateSteeringAgentsImportPlan,
  type SteeringAgentsImportAction,
  type SteeringAgentsImportApplyInput,
  type SteeringAgentsImportApplyResult,
  type SteeringAgentsImportAuthorization,
  type SteeringAgentsImportIssue,
  type SteeringAgentsImportPlan,
  type SteeringAgentsImportPublicationAction,
  type SteeringAgentsImportResult,
} from "./types";

interface SourceFreshness {
  readonly issues: readonly SteeringAgentsImportIssue[];
  readonly current: ReadonlyMap<string, AgentsObservation>;
}

type AuthorityState = {
  readonly head: SteeringTransactionResult["head"];
  readonly steering_generation: string;
} | null;

function failure(issues: readonly SteeringAgentsImportIssue[]): SteeringAgentsImportApplyResult {
  return { ok: false, issues: freezeSteeringAgentsImport(stableSteeringAgentsImportIssues(issues)) };
}

function selectedActions(plan: SteeringAgentsImportPlan): SteeringAgentsImportAction[] {
  const byId = new Map(plan.actions.map((action) => [action.action_id, action]));
  return plan.selection.action_ids.map((id) => byId.get(id)!).sort((left, right) => compareText(left.resource, right.resource));
}

function publicationActions(actions: readonly SteeringAgentsImportAction[]): SteeringAgentsImportPublicationAction[] {
  return actions.filter((action): action is SteeringAgentsImportPublicationAction => action.kind === "create" || action.kind === "update");
}

function authorizationFor(
  value: unknown,
  plan: SteeringAgentsImportPlan,
): { authorization?: SteeringAgentsImportAuthorization; issues: readonly SteeringAgentsImportIssue[] } {
  if (value === undefined || value === null)
    return { issues: [{ code: "agents-import-authorization-required", detail: "authorization-missing" }] };
  const raw = value as { by?: { kind?: unknown }; actor?: { kind?: unknown } };
  const actor = raw.by ?? raw.actor;
  if (actor?.kind === "worker" || actor?.kind === "model")
    return { issues: [{ code: "agents-import-worker-unauthorized", detail: "nonhuman-actor" }] };
  const parsed = steeringAgentsImportAuthorizationSchema.safeParse(value);
  if (!parsed.success) return { issues: [{ code: "agents-import-authorization-required", detail: "authorization-invalid" }] };
  const authorization = parsed.data as SteeringAgentsImportAuthorization;
  if (authorization.project !== plan.project || authorization.plan.id !== plan.id || authorization.plan.hash !== plan.hash)
    return { issues: [{ code: "agents-import-authorization-required", detail: "authorization-plan-mismatch" }] };
  return { authorization, issues: [] };
}

function operationMarker(plan: SteeringAgentsImportPlan, authorization: SteeringAgentsImportAuthorization): string {
  const authorizationHash = hashCanonical({
    project: authorization.project,
    plan: authorization.plan,
    by: authorization.by,
    decided_at: authorization.decided_at,
    ...(authorization.channel === undefined ? {} : { channel: authorization.channel }),
  });
  return `steering-agents-import:${plan.id}:${plan.hash}:${authorizationHash}`;
}

function operationMatchesCommittedPlan(
  transaction: {
    readonly project: string;
    readonly operation: string;
    readonly actor: unknown;
    readonly channel?: unknown;
    readonly mutation: { readonly reason: string; readonly resources: readonly string[] };
    readonly events: readonly { readonly kind: string; readonly detail?: string }[];
  },
  plan: SteeringAgentsImportPlan,
  authorization: SteeringAgentsImportAuthorization,
  operation: string,
  marker: string,
  actions: readonly SteeringAgentsImportPublicationAction[],
): boolean {
  const resources = actions.map((action) => action.resource).sort(compareText);
  return transaction.project === plan.project && transaction.operation === operation && exact(transaction.actor, authorization.by) &&
    exact(transaction.channel, authorization.channel) && transaction.mutation.reason === marker &&
    exact(transaction.mutation.resources, resources) && transaction.events.some((event) =>
      event.kind === "steering-agents-sources-imported" && event.detail === marker);
}

function registryObservation(snapshot: SteeringStoreSnapshot | null, project: string) {
  if (snapshot === null) return steeringAgentsImportRegistryObservationSchema.parse({ status: "absent", project });
  return steeringAgentsImportRegistryObservationSchema.parse({
    status: "present",
    project,
    head: snapshot.head,
    commit_sequence: snapshot.head.sequence,
    steering_generation: snapshot.registry.generation,
    resources: snapshot.registry.resources.map((resource) => steeringExpectationFor(snapshot.registry, resource.id))
      .sort((left, right) => compareText(left.id, right.id)),
  });
}

async function loadRegistry(store: SteeringStore, project: string): Promise<SteeringStoreSnapshot | null> {
  try { return await store.loadRegistry(project as never); }
  catch (error) {
    if (error instanceof StorageError && error.code === "STORE_NOT_FOUND") return null;
    throw error;
  }
}

function sourceIssueAtPath(
  inspection: Awaited<ReturnType<typeof inspectAgentsInterop>>,
  path: string,
): boolean {
  return inspection.rejected_sources.some((source) => source.source_path === path) ||
    inspection.unsafe_paths.some((issue) => issue.path === path) ||
    inspection.diagnostics.some((issue) => issue.path === path && issue.severity === "error");
}

async function verifySelectedSources(plan: SteeringAgentsImportPlan, projectRoot: string): Promise<SourceFreshness> {
  const actions = selectedActions(plan);
  if (!actions.length) return { issues: [], current: new Map() };
  const inspection = await inspectAgentsInterop(projectRoot, { project: plan.project });
  const byPath = new Map(inspection.observations.map((observation) => [observation.source_path, observation]));
  const issues: SteeringAgentsImportIssue[] = [];
  const current = new Map<string, AgentsObservation>();

  for (const action of actions) {
    const reviewed = action.source.observation;
    const observed = byPath.get(reviewed.source_path);
    if (observed === undefined) {
      const moved = inspection.observations.find((candidate) => candidate.source.hash === reviewed.source.hash &&
        candidate.source.bytes === reviewed.source.bytes && candidate.source.media_type === reviewed.source.media_type);
      if (moved !== undefined) {
        const comparison = compareAgentsImportObservation(reviewed, moved);
        issues.push({
          code: "agents-import-source-stale",
          resource: action.resource,
          action: action.action_id,
          source_path: reviewed.source_path,
          reasons: comparison.status === "stale" ? [...comparison.reasons] : ["source-path-changed"],
        });
      } else if (sourceIssueAtPath(inspection, reviewed.source_path)) {
        issues.push({ code: "agents-import-source-unsafe", resource: action.resource, action: action.action_id,
          source_path: reviewed.source_path, detail: "source-rejected-during-reinspection" });
      } else {
        issues.push({ code: "agents-import-source-missing", resource: action.resource, action: action.action_id,
          source_path: reviewed.source_path });
      }
      continue;
    }
    const comparison = compareAgentsImportObservation(reviewed, observed);
    if (comparison.status === "invalid") {
      issues.push({ code: "agents-import-source-unsafe", resource: action.resource, action: action.action_id,
        source_path: reviewed.source_path, detail: "observation-invalid" });
      continue;
    }
    if (comparison.status === "stale") {
      issues.push({ code: "agents-import-source-stale", resource: action.resource, action: action.action_id,
        source_path: reviewed.source_path, reasons: [...comparison.reasons] });
      continue;
    }
    try {
      const source = agentsImportSourceFor(observed);
      if (!exact(source.mapping, action.source.mapping) || !exact(source.authoritative_provenance, action.source.authoritative_provenance)) {
        issues.push({ code: "agents-import-source-stale", resource: action.resource, action: action.action_id,
          source_path: reviewed.source_path, reasons: ["observation-identity-changed"], detail: "mapping-or-provenance-changed" });
        continue;
      }
      const bytes = agentsObservationBytes(observed);
      if (hashBytes(bytes) !== observed.source.hash || bytes.length !== observed.source.bytes) {
        issues.push({ code: "agents-import-source-unsafe", resource: action.resource, action: action.action_id,
          source_path: reviewed.source_path, detail: "reobserved-byte-integrity" });
        continue;
      }
    } catch {
      issues.push({ code: "agents-import-source-unsafe", resource: action.resource, action: action.action_id,
        source_path: reviewed.source_path, detail: "reobserved-source-conversion" });
      continue;
    }
    current.set(action.action_id, observed);
  }

  // A selected source may have been observed, but an incomplete or invalid scan
  // cannot prove that the bounded source inspection remained safe as a whole.
  if (!inspection.complete || inspection.status !== "valid")
    issues.push({ code: "agents-import-source-unsafe", detail: "reinspection-not-valid" });
  return { issues: stableSteeringAgentsImportIssues(issues), current };
}

function priorAuthority(previous: SteeringStoreSnapshot | null): AuthorityState {
  return previous === null ? null : {
    head: previous.head,
    steering_generation: previous.registry.generation,
  };
}

function resultFor(
  plan: SteeringAgentsImportPlan,
  operation: string,
  actions: readonly SteeringAgentsImportAction[],
  result: SteeringTransactionResult | undefined,
  previous: AuthorityState,
): SteeringAgentsImportResult {
  const publications = publicationActions(actions);
  const noOp = publications.length === 0;
  const previousState = previous === null ? { head: null, steering_generation: null } : previous;
  const currentState = result === undefined ? previousState : {
    head: result.head,
    steering_generation: result.steering_generation,
  };
  const value = steeringAgentsImportResultSchema.parse({
    schema: STEERING_AGENTS_IMPORT_RESULT_SCHEMA,
    status: noOp ? "no-op" : result?.replayed ? "replayed" : "committed",
    plan: { id: plan.id, hash: plan.hash },
    operation,
    committed: !noOp,
    replayed: result?.replayed ?? false,
    previous: previousState,
    current: currentState,
    created_resources: publications.filter((action) => action.kind === "create").map((action) => action.next),
    updated_resources: publications.filter((action) => action.kind === "update").map((action) => action.next),
    unchanged_resources: actions.filter((action) => action.kind === "unchanged").map((action) => action.resource),
    authoritative_commit: result?.commit_id ?? null,
    source_observations: actions.map((action) => action.source.observation),
    diagnostics: noOp ? [{ code: "agents-import-no-op" }] : [],
  }) as SteeringAgentsImportResult;
  return freezeSteeringAgentsImport(value) as SteeringAgentsImportResult;
}

function staleRegistryIssue(): SteeringAgentsImportIssue {
  return { code: "agents-import-registry-stale" };
}

/**
 * Re-observe selected AGENTS sources, validate exact authority, then publish
 * selected raw-guidance revisions in one SteeringStore CAS transaction.
 */
export async function applySteeringAgentsImport(input: SteeringAgentsImportApplyInput): Promise<SteeringAgentsImportApplyResult> {
  const planIssues = validateSteeringAgentsImportPlan(input.plan);
  if (planIssues.length) return failure(planIssues);
  const plan = freezeSteeringAgentsImport(input.plan) as SteeringAgentsImportPlan;
  if (!steeringProjectNamespaceSchema.safeParse(plan.project).success)
    return failure([{ code: "agents-import-plan-invalid", detail: "project" }]);
  const operationResult = operationIdSchema.safeParse(input.operation);
  if (!operationResult.success) return failure([{ code: "agents-import-plan-invalid", detail: "operation" }]);
  const operation = operationResult.data;
  const authorizationResult = authorizationFor(input.authorization, plan);
  if (authorizationResult.issues.length || authorizationResult.authorization === undefined)
    return failure(authorizationResult.issues);
  const authorization = authorizationResult.authorization;
  const actions = selectedActions(plan);
  const publications = publicationActions(actions);
  const marker = operationMarker(plan, authorization);

  // A committed operation is immutable. Replay takes precedence over fresh
  // source and HEAD observations, exactly as the SteeringStore contract does.
  const existingOperation = await input.store.findCommittedOperation(plan.project as never, operation);
  if (existingOperation !== null) {
    if (publications.length === 0 || !operationMatchesCommittedPlan(existingOperation.payload.transaction,
      plan, authorization, operation, marker, publications))
      throw new StorageError("STORE_OPERATION_REUSE", "OperationId is already bound to a different AGENTS import intent");
    const replay = await input.store.commit(existingOperation.payload.transaction);
    return { ok: true, result: resultFor(plan, operation, actions, replay,
      plan.registry.status === "present" ? { head: plan.registry.head, steering_generation: plan.registry.steering_generation } : null) };
  }

  const sources = await verifySelectedSources(plan, input.project_root);
  const current = await loadRegistry(input.store, plan.project);
  const freshnessIssues: SteeringAgentsImportIssue[] = [...sources.issues];
  let observedRegistry: unknown;
  try { observedRegistry = registryObservation(current, plan.project); }
  catch { freshnessIssues.push({ code: "agents-import-registry-stale", detail: "registry-observation-invalid" }); }
  if (observedRegistry !== undefined && !exact(plan.registry, observedRegistry)) freshnessIssues.push(staleRegistryIssue());
  if (freshnessIssues.length) {
    // A competing writer could publish this OperationId after the first lookup.
    // Recheck so durable idempotency remains more precise than stale preflight.
    if (publications.length) {
      const existing = await input.store.findCommittedOperation(plan.project as never, operation);
      if (existing !== null) {
        if (!operationMatchesCommittedPlan(existing.payload.transaction, plan, authorization, operation, marker, publications))
          throw new StorageError("STORE_OPERATION_REUSE", "OperationId is already bound to a different AGENTS import intent");
        const replay = await input.store.commit(existing.payload.transaction);
        return { ok: true, result: resultFor(plan, operation, actions, replay,
          plan.registry.status === "present" ? { head: plan.registry.head, steering_generation: plan.registry.steering_generation } : null) };
      }
    }
    return failure(freshnessIssues);
  }

  if (!publications.length)
    return { ok: true, result: resultFor(plan, operation, actions, undefined, priorAuthority(current)) };

  const created = {
    at: authorization.decided_at,
    by: authorization.by,
    operation,
    ...(authorization.channel === undefined ? {} : { channel: authorization.channel }),
  };
  let revisions;
  try { revisions = publications.map((action) => constructSteeringAgentsImportRevision(action, created)); }
  catch { return failure([{ code: "agents-import-plan-invalid", detail: "revision-construction" }]); }
  const closure = validateSteeringAgentsImportCandidateClosure(plan.project, (current?.revisions ?? []) as never, revisions as never);
  if (closure.length) return failure(closure);

  let registry;
  try { registry = registryAfterSteeringAgentsImport(current?.registry ?? null, plan.project, revisions as never); }
  catch { return failure([{ code: "agents-import-plan-invalid", detail: "registry-construction" }]); }
  const resourceIds = publications.map((action) => action.resource).sort(compareText);
  const transaction = steeringTransactionSchema.parse({
    schema: "aira.dev/steering-store-transaction/v1",
    project: plan.project,
    operation,
    expected: plan.registry.status === "absent" ? null : {
      head: plan.registry.head,
      resources: publications.map((action) => action.expectation).sort((left, right) => compareText(left.id, right.id)),
    },
    mutation: {
      kind: plan.registry.status === "absent" ? "create" : "publish",
      resources: resourceIds,
      reason: marker,
    },
    actor: authorization.by,
    ...(authorization.channel === undefined ? {} : { channel: authorization.channel }),
    registry,
    events: [{ kind: "steering-agents-sources-imported", resources: resourceIds, detail: marker, payloads: [] }],
  });
  const revisionInputs = publications.map((action, index) => ({
    revision: revisions[index]!,
    body: Uint8Array.from(agentsObservationBytes(sources.current.get(action.action_id)!)),
  }));
  try {
    const result = plan.registry.status === "absent" ?
      await input.store.createRegistry(transaction, revisionInputs) : await input.store.commit(transaction, revisionInputs);
    return { ok: true, result: resultFor(plan, operation, actions, result, priorAuthority(current)) };
  } catch (error) {
    if (error instanceof StorageError && (error.code === "STORE_CONFLICT" || error.code === "STORE_ALREADY_EXISTS"))
      return failure([staleRegistryIssue()]);
    throw error;
  }
}

export const applySteeringAgentsImportPlan = applySteeringAgentsImport;
export const applyAgentsInteropImport = applySteeringAgentsImport;
