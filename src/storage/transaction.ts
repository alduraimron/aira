import { exact } from "../spec/domain/primitives";
import { successor, type CommitSequence } from "../spec/domain/generations";
import type { StoreCommit, StoreHead, StoreState, StoreTransaction } from "./types";
import { fail, StorageError } from "./errors";

export function nextSequence(sequence: CommitSequence): CommitSequence {
  const next = successor(sequence);
  if (!next.ok) fail("STORE_CONFLICT", "CommitSequence overflow");
  return next.value;
}
export function runCounters(state: StoreState): StoreHead["run_generations"] {
  return state.runs.map((r) => ({ run: r.id, generation: r.generation })).sort((a, b) => a.run < b.run ? -1 : a.run > b.run ? 1 : 0);
}
export function headOf(commit: StoreCommit): StoreHead {
  const p = commit.payload;
  return { schema: "aira.dev/store-head/v1", spec_id: p.spec_id, commit_id: commit.id, sequence: p.sequence,
    spec_generation: p.spec_generation, run_id: p.run_id, run_generation: p.run_generation, run_generations: p.run_generations };
}
export function checkExpectations(t: StoreTransaction, head: StoreHead, current: StoreState): void {
  const e = t.expected;
  if (!e || !exact(e.head, head) || !exact(e.current_artifacts, current.spec.artifacts.current)) fail("STORE_CONFLICT", "Authoritative CAS expectations changed");
  for (const x of e.execution) {
    const run = current.runs.find((r) => r.id === x.run), task = run?.tasks.find((s) => exact(s.task, x.task));
    const claim = run?.claims.find((c) => c.id === x.claim);
    if (!task || task.status !== x.status || (task.current_attempt ?? null) !== x.attempt || (task.claim ?? null) !== x.claim ||
      (x.fence !== null && (!claim || claim.status !== "active" || !exact(claim.fence, x.fence)))) fail("STORE_CONFLICT", "Execution/fence expectations changed");
  }
}
/** Storage scope rules only. This does not approve artifacts or execute lifecycle transitions. */
export function checkEvolution(t: StoreTransaction, previous: StoreState | null, sequence: CommitSequence): void {
  const state = t.state, changed = t.mutation;
  if (state.spec.id !== t.spec_id || state.runs.some((r) => r.snapshot.spec_id !== t.spec_id)) fail("STORE_INTEGRITY", "State belongs to another Spec");
  if (state.spec.run_binding && !state.runs.some((r) => r.id === state.spec.run_binding!.run && exact(r.snapshot, state.spec.run_binding!.snapshot)))
    fail("STORE_INTEGRITY", "Missing/mismatched bound run");
  if (state.spec.commit_sequence !== undefined && BigInt(state.spec.commit_sequence) > BigInt(sequence)) fail("STORE_INTEGRITY", "Future Spec sequence");
  if (state.runs.some((r) => BigInt(r.commit_sequence) > BigInt(sequence))) fail("STORE_INTEGRITY", "Future run sequence");
  if (!previous) {
    if (sequence !== "1" || !changed.spec || state.spec.generation !== "0" || state.runs.length || changed.runs.length)
      fail("STORE_INTEGRITY", "Genesis establishes Spec generation zero and no runs at sequence one");
    return;
  }
  const wantSpec = changed.spec ? BigInt(previous.spec.generation) + 1n : BigInt(previous.spec.generation);
  if (BigInt(state.spec.generation) !== wantSpec) fail("STORE_CONFLICT", "Invalid SpecGeneration advancement");
  if (!changed.spec && !exact(state.spec, previous.spec)) fail("STORE_CONFLICT", "Run/audit mutation changed Spec semantics");
  const semantic = (s: StoreState) => {
    const { generation: _, commit_sequence: __, updated_at: ___, ...spec } = s.spec;
    return { spec, records: s.records, environment: s.behavioral_environment };
  };
  if (changed.spec && exact(semantic(state), semantic(previous))) fail("STORE_CONFLICT", "SpecGeneration cannot advance for bookkeeping alone");
  // Core decides applicability. Once it declares a binding superseded, storage must
  // not publish that declaration separately from revoking its live authorities.
  const oldBinding = previous.spec.run_binding, newBinding = state.spec.run_binding;
  if (oldBinding?.status === "applicable" && (!newBinding || newBinding.run !== oldBinding.run ||
    newBinding.status !== "applicable" || !exact(newBinding.snapshot, oldBinding.snapshot))) {
    const old = previous.runs.find((r) => r.id === oldBinding.run);
    if (old && (old.claims.some((c) => c.status === "active") || old.authorities.some((a) => a.status === "active"))) {
      const run = state.runs.find((r) => r.id === old.id);
      if (!changed.runs.includes(old.id) || !run || run.claims.some((c) => c.status === "active") || run.authorities.some((a) => a.status === "active"))
        fail("STORE_CONFLICT", "Superseding active execution inputs must revoke publication authority in the same transaction");
    }
  }
  for (const old of previous.runs) if (!state.runs.some((r) => r.id === old.id)) fail("STORE_INTEGRITY", "Runs cannot be removed/reassigned");
  for (const run of state.runs) {
    const old = previous.runs.find((r) => r.id === run.id), changes = changed.runs.includes(run.id);
    if (!old) {
      if (!changes || run.generation !== "0" || run.commit_sequence !== sequence) fail("STORE_CONFLICT", "New run must explicitly establish generation zero at its publication sequence");
    } else if (!exact(run.snapshot, old.snapshot)) {
      fail("STORE_INTEGRITY", "Run identity cannot be rebound to different approved inputs");
    } else if (changes) {
      if (BigInt(run.generation) !== BigInt(old.generation) + 1n || run.commit_sequence !== sequence) fail("STORE_CONFLICT", "Invalid RunGeneration advancement");
    } else if (!exact(run, old)) fail("STORE_CONFLICT", "Run changed without generation advancement");
  }
  if (changed.runs.some((id) => !state.runs.some((r) => r.id === id))) fail("STORE_CONFLICT", "Unknown mutated run");
  if (!changed.spec && !changed.runs.length && !exact(state, previous)) fail("STORE_CONFLICT", "Audit-only transaction changed domain state");
  // Behavioral attribution and identity history are never erased by a later snapshot.
  if (previous.spec.behavioral_profiles.some((binding) => !state.spec.behavioral_profiles.some((b) => exact(b, binding))))
    fail("STORE_INTEGRITY", "Historical behavioral binding changed");
}
export function checkCommitMetadata(commit: StoreCommit): void {
  const p = commit.payload, t = p.transaction, state = t.state;
  if (p.spec_id !== t.spec_id || p.spec_generation !== state.spec.generation || !exact(p.run_generations, runCounters(state)) ||
    p.run_id !== (state.spec.run_binding?.run ?? null) || p.run_generation !== (state.runs.find((r) => r.id === p.run_id)?.generation ?? "0"))
    fail("STORE_CORRUPT_COMMIT", "Commit state/generation mismatch");
  if (t.expected === null) {
    if (p.parent !== null || p.sequence !== "1") fail("STORE_CORRUPT_COMMIT", "Invalid genesis");
    checkEvolution(t, null, p.sequence);
  } else if (p.parent !== t.expected.head.commit_id || p.sequence !== nextSequence(t.expected.head.sequence)) fail("STORE_CORRUPT_COMMIT", "Parent/sequence mismatch");
}
export function checkParent(child: StoreCommit, parent: StoreCommit): void {
  if (child.payload.parent !== parent.id || child.payload.spec_id !== parent.payload.spec_id ||
    child.payload.sequence !== nextSequence(parent.payload.sequence) || !exact(child.payload.transaction.expected?.head, headOf(parent)))
    fail("STORE_CORRUPT_COMMIT", "Broken parent chain");
  try {
    checkExpectations(child.payload.transaction, headOf(parent), parent.payload.transaction.state);
    checkEvolution(child.payload.transaction, parent.payload.transaction.state, child.payload.sequence);
  } catch (error) {
    throw new StorageError("STORE_CORRUPT_COMMIT", "Committed transaction violates parent preconditions/evolution", { cause: error });
  }
}
