import { hashBytes, hashCanonical } from "../canonical-json";
import { operationIdSchema } from "../spec/domain/ids";
import { compareText, exact } from "../spec/domain/primitives";
import { steeringProjectNamespaceSchema } from "../steering/schema";
import { compareSteeringSourceObservations, inspectNativeSteering, type SteeringSourceParseSuccess } from "../steering-source";
import { StorageError } from "../storage/errors";
import { type SteeringStore } from "../storage/steering-store";
import {
  steeringExpectationFor,
  steeringTransactionSchema,
  type SteeringStoreSnapshot,
  type SteeringTransactionResult,
} from "../storage/steering-types";
import {
  constructSteeringAdoptionRevision,
  registryAfterSteeringAdoption,
  validateSteeringAdoptionCandidateClosure,
} from "./plan";
import {
  STEERING_ADOPTION_RESULT_SCHEMA,
  freezeSteeringAdoption,
  stableSteeringAdoptionIssues,
  steeringAdoptionAuthorizationSchema,
  steeringAdoptionRegistryObservationSchema,
  steeringAdoptionResultSchema,
  validateSteeringAdoptionPlan,
  type SteeringAdoptionAction,
  type SteeringAdoptionApplyInput,
  type SteeringAdoptionApplyResult,
  type SteeringAdoptionAuthorization,
  type SteeringAdoptionIssue,
  type SteeringAdoptionPlan,
  type SteeringAdoptionPublicationAction,
  type SteeringAdoptionResult,
} from "./types";

interface SourceFreshness {
  readonly issues: readonly SteeringAdoptionIssue[];
  readonly current: ReadonlyMap<string, SteeringSourceParseSuccess>;
}

function applyFailure(issues: readonly SteeringAdoptionIssue[]): SteeringAdoptionApplyResult {
  return { ok: false, issues: freezeSteeringAdoption(stableSteeringAdoptionIssues(issues)) };
}

function selectedActions(plan: SteeringAdoptionPlan): SteeringAdoptionAction[] {
  const byId = new Map(plan.actions.map((action) => [action.action_id, action]));
  return plan.selection.action_ids.map((id) => byId.get(id)!).sort((left, right) => compareText(left.resource, right.resource));
}

function publicationActions(actions: readonly SteeringAdoptionAction[]): SteeringAdoptionPublicationAction[] {
  return actions.filter((action): action is SteeringAdoptionPublicationAction => action.kind === "create" || action.kind === "update");
}

function authorizationFor(value: unknown, plan: SteeringAdoptionPlan): { authorization?: SteeringAdoptionAuthorization; issues: SteeringAdoptionIssue[] } {
  if (value === undefined || value === null)
    return { issues: [{ code: "adoption-authorization-required", detail: "authorization-missing" }] };
  const raw = value as { by?: { kind?: unknown }; actor?: { kind?: unknown } };
  const actor = raw.by ?? raw.actor;
  if (actor?.kind === "worker" || actor?.kind === "model")
    return { issues: [{ code: "adoption-worker-unauthorized", detail: "nonhuman-actor" }] };
  const parsed = steeringAdoptionAuthorizationSchema.safeParse(value);
  if (!parsed.success) return { issues: [{ code: "adoption-authorization-required", detail: "authorization-invalid" }] };
  const authorization = parsed.data as SteeringAdoptionAuthorization;
  if (authorization.project !== plan.project || authorization.plan.id !== plan.id || authorization.plan.hash !== plan.hash)
    return { issues: [{ code: "adoption-authorization-required", detail: "authorization-plan-mismatch" }] };
  return { authorization, issues: [] };
}

function operationMarker(plan: SteeringAdoptionPlan, authorization: SteeringAdoptionAuthorization): string {
  const authorizationHash = hashCanonical({
    project: authorization.project,
    plan: authorization.plan,
    by: authorization.by,
    decided_at: authorization.decided_at,
    ...(authorization.channel === undefined ? {} : { channel: authorization.channel }),
  });
  return `steering-adoption:${plan.id}:${plan.hash}:${authorizationHash}`;
}

function operationMatchesCommittedPlan(
  transaction: { readonly project: string; readonly operation: string; readonly actor: unknown; readonly channel?: unknown;
    readonly mutation: { readonly reason: string; readonly resources: readonly string[] }; readonly events: readonly { readonly kind: string; readonly detail?: string }[] },
  plan: SteeringAdoptionPlan,
  authorization: SteeringAdoptionAuthorization,
  operation: string,
  marker: string,
  actions: readonly SteeringAdoptionPublicationAction[],
): boolean {
  const resources = actions.map((action) => action.resource).sort(compareText);
  return transaction.project === plan.project && transaction.operation === operation && exact(transaction.actor, authorization.by) &&
    exact(transaction.channel, authorization.channel) && transaction.mutation.reason === marker &&
    exact(transaction.mutation.resources, resources) && transaction.events.some((event) =>
      event.kind === "steering-native-sources-adopted" && event.detail === marker);
}

function registryObservation(snapshot: SteeringStoreSnapshot | null, project: string) {
  if (snapshot === null) return steeringAdoptionRegistryObservationSchema.parse({ status: "absent", project });
  return steeringAdoptionRegistryObservationSchema.parse({
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

async function verifySelectedSources(plan: SteeringAdoptionPlan, projectRoot: string): Promise<SourceFreshness> {
  const actions = selectedActions(plan);
  if (actions.length === 0) return { issues: [], current: new Map() };
  const inspection = await inspectNativeSteering(projectRoot, { project: plan.project });
  const issues: SteeringAdoptionIssue[] = [];
  const current = new Map<string, SteeringSourceParseSuccess>();
  if (inspection.status !== "valid" || !inspection.complete) {
    issues.push({ code: "adoption-source-unsafe", detail: "reinspection-not-valid" });
    return { issues: stableSteeringAdoptionIssues(issues), current };
  }
  const byPath = new Map(inspection.proposals.map((source) => [source.observation.source_path, source]));
  const byResource = new Map(inspection.proposals.map((source) => [source.observation.identity.id, source]));
  for (const action of actions) {
    const reviewed = action.source.observation;
    const observed = byPath.get(reviewed.source_path);
    if (observed === undefined) {
      const moved = byResource.get(reviewed.identity.id);
      if (moved !== undefined) issues.push({
        code: "adoption-plan-source-stale",
        resource: action.resource,
        action: action.action_id,
        source_path: reviewed.source_path,
        reasons: ["source-path-changed"],
      });
      else issues.push({ code: "adoption-source-missing", resource: action.resource, action: action.action_id,
        source_path: reviewed.source_path });
      continue;
    }
    const comparison = compareSteeringSourceObservations(reviewed, observed.observation);
    if (comparison.status !== "match" || !exact(action.source.proposal, observed.proposal)) {
      issues.push({
        code: "adoption-plan-source-stale",
        resource: action.resource,
        action: action.action_id,
        source_path: reviewed.source_path,
        reasons: comparison.status === "stale" ? comparison.reasons : ["source-observation-invalid"],
        ...(comparison.status === "match" ? { detail: "proposal-mismatch" } : {}),
      });
      continue;
    }
    if (hashBytes(observed.source_bytes) !== observed.observation.source.hash || observed.source_bytes.length !== observed.observation.source.bytes ||
      hashBytes(observed.body_bytes) !== observed.observation.body.hash || observed.body_bytes.length !== observed.observation.body.bytes) {
      issues.push({ code: "adoption-source-unsafe", resource: action.resource, action: action.action_id,
        source_path: reviewed.source_path, detail: "reobserved-byte-integrity" });
      continue;
    }
    current.set(action.action_id, observed);
  }
  return { issues: stableSteeringAdoptionIssues(issues), current };
}

function priorAuthority(previous: SteeringStoreSnapshot | null): { readonly head: SteeringTransactionResult["head"]; readonly steering_generation: SteeringTransactionResult["steering_generation"] } | null {
  return previous === null ? null : { head: previous.head, steering_generation: previous.registry.generation };
}

function resultFor(
  plan: SteeringAdoptionPlan,
  operation: string,
  actions: readonly SteeringAdoptionAction[],
  result: SteeringTransactionResult | undefined,
  previous: { readonly head: SteeringTransactionResult["head"]; readonly steering_generation: SteeringTransactionResult["steering_generation"] } | null,
): SteeringAdoptionResult {
  const publications = publicationActions(actions);
  const noOp = publications.length === 0;
  const previousState = previous === null ? { head: null, steering_generation: null } : previous;
  const currentState = result === undefined ? previousState : {
    head: result.head,
    steering_generation: result.steering_generation,
  };
  const value = steeringAdoptionResultSchema.parse({
    schema: STEERING_ADOPTION_RESULT_SCHEMA,
    status: noOp ? "no-op" : "committed",
    plan: { id: plan.id, hash: plan.hash },
    operation,
    committed: !noOp,
    replayed: result?.replayed ?? false,
    previous: previousState,
    current: currentState,
    created_revisions: publications.filter((action) => action.kind === "create").map((action) => action.next),
    updated_revisions: publications.filter((action) => action.kind === "update").map((action) => action.next),
    unchanged_resources: actions.filter((action) => action.kind === "unchanged").map((action) => action.resource),
    retired_resources: [],
    authoritative_commit: result?.commit_id ?? null,
    source_observations: actions.map((action) => action.source.observation),
    issues: noOp ? [{ code: "adoption-no-op" }] : [],
  }) as SteeringAdoptionResult;
  return freezeSteeringAdoption(value) as SteeringAdoptionResult;
}

function staleRegistryIssue(): SteeringAdoptionIssue {
  return { code: "adoption-plan-registry-stale" };
}

/**
 * Re-observe selected native sources, validate exact registry CAS state, then
 * publish all selected revisions in one SteeringStore transaction. A replayed
 * committed OperationId is delegated to the store before freshness checks.
 */
export async function applySteeringAdoption(input: SteeringAdoptionApplyInput): Promise<SteeringAdoptionApplyResult> {
  const planIssues = validateSteeringAdoptionPlan(input.plan);
  if (planIssues.length) return applyFailure(planIssues);
  const plan = input.plan as SteeringAdoptionPlan;
  if (!steeringProjectNamespaceSchema.safeParse(plan.project).success)
    return applyFailure([{ code: "adoption-plan-invalid", detail: "project" }]);
  const operationResult = operationIdSchema.safeParse(input.operation);
  if (!operationResult.success) return applyFailure([{ code: "adoption-plan-invalid", detail: "operation" }]);
  const operation = operationResult.data;
  const authorizationResult = authorizationFor(input.authorization, plan);
  if (authorizationResult.issues.length || authorizationResult.authorization === undefined)
    return applyFailure(authorizationResult.issues);
  const authorization = authorizationResult.authorization;
  const actions = selectedActions(plan);
  const publications = publicationActions(actions);
  const marker = operationMarker(plan, authorization);

  // A successful prior commit is immutable. Retrying it must converge even if
  // sources or HEAD subsequently changed, while a different intent is rejected.
  const existingOperation = await input.store.findCommittedOperation(plan.project as never, operation);
  if (existingOperation !== null) {
    if (publications.length === 0 || !operationMatchesCommittedPlan(existingOperation.payload.transaction,
      plan, authorization, operation, marker, publications))
      throw new StorageError("STORE_OPERATION_REUSE", "OperationId is already bound to a different Steering adoption intent");
    const replay = await input.store.commit(existingOperation.payload.transaction);
    return { ok: true, result: resultFor(plan, operation, actions, replay, plan.registry.status === "present" ? {
      head: plan.registry.head,
      steering_generation: plan.registry.steering_generation,
    } : null) };
  }

  const sources = await verifySelectedSources(plan, input.project_root);
  const current = await loadRegistry(input.store, plan.project);
  const freshnessIssues: SteeringAdoptionIssue[] = [...sources.issues];
  let observedRegistry: unknown;
  try { observedRegistry = registryObservation(current, plan.project); }
  catch { freshnessIssues.push({ code: "adoption-plan-registry-stale", detail: "registry-observation-invalid" }); }
  if (observedRegistry !== undefined && !exact(plan.registry, observedRegistry)) freshnessIssues.push(staleRegistryIssue());
  if (freshnessIssues.length) {
    // Another process can commit this OperationId after the first replay lookup.
    // Recheck before reporting freshness so store idempotency remains authoritative.
    if (publications.length) {
      const existing = await input.store.findCommittedOperation(plan.project as never, operation);
      if (existing !== null) {
        if (!operationMatchesCommittedPlan(existing.payload.transaction, plan, authorization, operation, marker, publications))
          throw new StorageError("STORE_OPERATION_REUSE", "OperationId is already bound to a different Steering adoption intent");
        const replay = await input.store.commit(existing.payload.transaction);
        return { ok: true, result: resultFor(plan, operation, actions, replay, plan.registry.status === "present" ? {
          head: plan.registry.head,
          steering_generation: plan.registry.steering_generation,
        } : null) };
      }
    }
    return applyFailure(freshnessIssues);
  }

  if (publications.length === 0)
    return { ok: true, result: resultFor(plan, operation, actions, undefined, priorAuthority(current)) };

  const created = {
    at: authorization.decided_at,
    by: authorization.by,
    operation,
    ...(authorization.channel === undefined ? {} : { channel: authorization.channel }),
  };
  let revisions;
  try { revisions = publications.map((action) => constructSteeringAdoptionRevision(action, created)); }
  catch { return applyFailure([{ code: "adoption-plan-invalid", detail: "revision-construction" }]); }
  const closure = validateSteeringAdoptionCandidateClosure(plan.project, (current?.revisions ?? []) as never, revisions);
  if (closure.length) return applyFailure(closure);

  let registry;
  try { registry = registryAfterSteeringAdoption(current?.registry ?? null, plan.project, revisions); }
  catch { return applyFailure([{ code: "adoption-plan-invalid", detail: "registry-construction" }]); }
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
    events: [{ kind: "steering-native-sources-adopted", resources: resourceIds, detail: marker, payloads: [] }],
  });
  const revisionInputs = publications.map((action, index) => ({
    revision: revisions[index]!,
    body: Uint8Array.from(sources.current.get(action.action_id)!.body_bytes),
  }));
  try {
    const result = plan.registry.status === "absent" ?
      await input.store.createRegistry(transaction, revisionInputs) : await input.store.commit(transaction, revisionInputs);
    return { ok: true, result: resultFor(plan, operation, actions, result, priorAuthority(current)) };
  } catch (error) {
    if (error instanceof StorageError && (error.code === "STORE_CONFLICT" || error.code === "STORE_ALREADY_EXISTS"))
      return applyFailure([staleRegistryIssue()]);
    throw error;
  }
}

export const applySteeringAdoptionPlan = applySteeringAdoption;
export const applyNativeSteeringAdoption = applySteeringAdoption;
