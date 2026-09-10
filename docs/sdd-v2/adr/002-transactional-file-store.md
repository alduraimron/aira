# ADR-002: Transactional file store with one publication point

Status: accepted. Normative for v2; implementation is deferred.

## Context

V1 replaces `run.json` atomically but does not implement transactional compare-and-swap (CAS) across records. Independent updates of `spec.yaml`, approvals, artifacts, and `events.jsonl` cannot form an aggregate transaction.

## Decision

Within a store transaction scope, one authoritative HEAD selects one immutable commit/state record, which identifies the complete committed aggregate (directly or through immutable references). All Spec/run/approval/evidence state participating in an invariant MUST share this publication point. Multiple independent roots cannot pretend to commit that invariant atomically.

A transaction MUST perform this ordered protocol:

1. Acquire cross-process ownership/lock covering the transaction scope. All writers participate, including scheduler, human decisions, and recovery. The lock identity must not be lost when replacing HEAD; a process-local mutex is insufficient.
2. Read the current authoritative HEAD and committed state under that ownership.
3. Verify expected transaction identity/commit state and relevant expected Spec generation, run generation, snapshot, claim/fence, and domain preconditions. On conflict, publish nothing authoritative; reload/reprepare rather than blindly overwriting stale state.
4. Publish immutable referenced records, artifact revisions, and blobs. Existing identities MUST NOT be overwritten with different bytes. References include integrity identities/hashes.
5. Fsync required durable files and directories, including newly created reference paths, before making them reachable through HEAD.
6. Publish one immutable commit/state record containing commit sequence, parent identity, transaction identity, resulting state references/generations, and authoritative mutation/audit facts. Fsync this record and its directory before publishing HEAD.
7. Atomically advance HEAD to that commit using a same-filesystem atomic replacement. Prepare and fsync the replacement pointer before the rename. Ownership plus expected-state validation is the CAS contract; rename alone is not CAS.
8. Fsync HEAD's containing directory. Only then acknowledge durable transaction success. Release ownership after authoritative publication is secured.
9. Update human-friendly materialized views only after authoritative publication. Their success is not part of deciding which state committed.

The exact lock primitive, encoding, and layout are deferred, not these ordering and ownership requirements. Supported filesystems/backends must provide the required durability/atomicity; unsupported guarantees fail closed rather than advertising transaction safety. Ownership recovery must fence stale writers, not merely delete an old-looking lock while its owner could still publish.

## Crash and recovery contract

| Boundary | Authoritative interpretation |
| --- | --- |
| Before HEAD advancement | Previous HEAD remains authoritative. New records/commit files are unreachable and non-authoritative. |
| After HEAD advancement | The new state selected by HEAD is authoritative; views can be rebuilt. A process crash before view refresh does not undo the commit. |
| Power loss before final directory fsync | Durable recovery may expose the previous or new HEAD, never a partially published aggregate. No durability acknowledgement has yet been issued. |
| After final directory fsync, before acknowledgement reaches caller | New HEAD is durable; caller uncertainty is resolved using committed transaction identity, not by rerunning external side effects. |
| During/after view updates | HEAD remains authoritative even if views are absent, stale, malformed, or partially refreshed. |

Recovery reads and validates HEAD and the immutable records it selects. It MUST NOT adopt an orphan because it has the largest sequence or newest timestamp. Missing/corrupt authoritative records are integrity errors, not permission to infer state from views. Readers pin one HEAD for a consistent read instead of mixing references from multiple commits. Garbage collection must preserve reachable history and cannot race pinned reads or active publication.

`spec.yaml`, Markdown views/checkboxes, approval display files, and `events.jsonl` are derived when exposed outside the committed record set. They are not authoritative scheduler state. Audit/event views can be reconstructed from authoritative commit records; `events.jsonl` is not the sole recovery journal. Operator display events are not a substitute for committed audit facts or immutable verification evidence.

## Consequences

Crash testing must cover every durability/publication boundary and multi-process contention. Independent atomic file replacements, a JSONL-only journal, and last-writer-wins saves are rejected. This task does not implement the store or change v1 saving behavior.

## Invariants

INV-STORE-001, INV-STORE-002, INV-STORE-003, INV-STORE-004, INV-GEN-001.
