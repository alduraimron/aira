import { exact } from "../spec/domain/primitives";
import type { SteeringRegistry, SteeringRegistryResource, SteeringCommit, SteeringHead, SteeringTransaction } from "./steering-types";
import { nextSequence } from "./transaction";
import { fail, StorageError } from "./errors";

export function steeringHeadOf(commit: SteeringCommit): SteeringHead {
  const payload = commit.payload;
  return {
    schema: "aira.dev/steering-store-head/v1",
    project: payload.project,
    commit_id: commit.id,
    sequence: payload.sequence,
    steering_generation: payload.steering_generation,
  };
}

function currentExpectation(resource: SteeringRegistryResource | undefined) {
  if (!resource) return { status: "absent" };
  return resource.status === "active" ? { status: "active", current: resource.current } : { status: "retired" };
}

export function checkSteeringExpectations(
  transaction: SteeringTransaction,
  head: SteeringHead,
  current: SteeringRegistry,
): void {
  const expected = transaction.expected;
  if (!expected || !exact(expected.head, head)) fail("STORE_CONFLICT", "Authoritative Steering HEAD expectation changed");
  for (const expectation of expected.resources) {
    const resource = current.resources.find((entry) => entry.id === expectation.id);
    const actual = { id: expectation.id, ...currentExpectation(resource) };
    if (!exact(expectation, actual)) fail("STORE_CONFLICT", `Current Steering revision changed: ${expectation.id}`);
  }
}

function semanticRegistry(registry: SteeringRegistry): Omit<SteeringRegistry, "generation"> {
  const { generation: _generation, ...semantic } = registry;
  return semantic;
}

function changedResources(previous: SteeringRegistry, next: SteeringRegistry): string[] {
  const ids = [...new Set([...previous.resources.map((resource) => resource.id), ...next.resources.map((resource) => resource.id)])].sort();
  return ids.filter((id) => !exact(previous.resources.find((resource) => resource.id === id), next.resources.find((resource) => resource.id === id)));
}

/** Storage authority evolution only. Pure Steering validators own revision semantics. */
export function checkSteeringEvolution(transaction: SteeringTransaction, previous: SteeringRegistry | null): void {
  const registry = transaction.registry;
  if (registry.project !== transaction.project) fail("STORE_INTEGRITY", "Steering registry belongs to another project");
  if (previous === null) {
    if (transaction.expected !== null || transaction.mutation.kind !== "create" || registry.generation !== "0")
      fail("STORE_INTEGRITY", "Steering genesis establishes generation zero under absent-registry CAS");
    return;
  }
  if (transaction.expected === null || transaction.mutation.kind === "create")
    fail("STORE_CONFLICT", "Existing Steering registry cannot be recreated");
  if (previous.project !== registry.project) fail("STORE_INTEGRITY", "Steering project identity cannot change");

  const semanticMutation = transaction.mutation.kind !== "audit";
  const expectedGeneration = semanticMutation ? BigInt(previous.generation) + 1n : BigInt(previous.generation);
  if (BigInt(registry.generation) !== expectedGeneration)
    fail("STORE_CONFLICT", "Invalid SteeringGeneration advancement");
  if (semanticMutation && exact(semanticRegistry(previous), semanticRegistry(registry)))
    fail("STORE_CONFLICT", "SteeringGeneration cannot advance for bookkeeping alone");
  if (!semanticMutation && !exact(registry, previous))
    fail("STORE_CONFLICT", "Audit-only Steering transaction changed authoritative state");

  const changed = changedResources(previous, registry);
  if (!exact(changed, transaction.mutation.resources))
    fail("STORE_CONFLICT", "Steering mutation category does not name the changed resources");

  for (const old of previous.resources) {
    const next = registry.resources.find((resource) => resource.id === old.id);
    if (!next) fail("STORE_INTEGRITY", "Steering resource history cannot be removed");
    for (const revision of old.revisions) {
      const retained = next.revisions.find((candidate) => candidate.identity.revision === revision.identity.revision);
      if (!retained || !exact(retained, revision)) fail("STORE_INTEGRITY", "Immutable Steering revision reference changed or disappeared");
    }
    if (old.status === "retired" && !exact(old, next))
      fail("STORE_INTEGRITY", "Retired Steering resource identity cannot be reused");
  }

  if (transaction.mutation.kind === "publish") for (const id of transaction.mutation.resources) {
    const before = previous.resources.find((resource) => resource.id === id);
    const after = registry.resources.find((resource) => resource.id === id);
    if (!after || after.status !== "active" || (before && after.revisions.length <= before.revisions.length))
      fail("STORE_CONFLICT", "Publish mutation must add a current immutable Steering revision");
  }
  if (transaction.mutation.kind === "retire") for (const id of transaction.mutation.resources) {
    const before = previous.resources.find((resource) => resource.id === id);
    const after = registry.resources.find((resource) => resource.id === id);
    if (!before || before.status !== "active" || !after || after.status !== "retired" ||
      !exact(before.revisions, after.revisions))
      fail("STORE_CONFLICT", "Retire mutation must preserve exact revision history and clear current authority");
  }
}

export function checkSteeringCommitMetadata(commit: SteeringCommit): void {
  const payload = commit.payload;
  const transaction = payload.transaction;
  if (payload.project !== transaction.project || payload.steering_generation !== transaction.registry.generation)
    fail("STORE_CORRUPT_COMMIT", "Steering commit registry/generation mismatch");
  if (transaction.expected === null) {
    if (payload.parent !== null || payload.sequence !== "1") fail("STORE_CORRUPT_COMMIT", "Invalid Steering genesis commit");
    try { checkSteeringEvolution(transaction, null); }
    catch (error) { throw new StorageError("STORE_CORRUPT_COMMIT", "Invalid Steering genesis state", { cause: error }); }
  } else if (payload.parent !== transaction.expected.head.commit_id ||
    payload.sequence !== nextSequence(transaction.expected.head.sequence)) {
    fail("STORE_CORRUPT_COMMIT", "Steering commit parent/sequence mismatch");
  }
}

export function checkSteeringParent(child: SteeringCommit, parent: SteeringCommit): void {
  if (child.payload.parent !== parent.id || child.payload.project !== parent.payload.project ||
    child.payload.sequence !== nextSequence(parent.payload.sequence) ||
    !exact(child.payload.transaction.expected?.head, steeringHeadOf(parent)))
    fail("STORE_CORRUPT_COMMIT", "Broken Steering parent chain");
  try {
    checkSteeringExpectations(child.payload.transaction, steeringHeadOf(parent), parent.payload.transaction.registry);
    checkSteeringEvolution(child.payload.transaction, parent.payload.transaction.registry);
  } catch (error) {
    throw new StorageError("STORE_CORRUPT_COMMIT", "Committed Steering transaction violates parent preconditions/evolution", { cause: error });
  }
}
