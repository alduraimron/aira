# ADR-003: Separate generations, exact approvals, and fencing

Status: accepted. Normative for v2.

## Context

One generation counter would conflate publication order, human-reviewed Spec semantics, and active execution bookkeeping. It would either permit stale publication or invalidate review on every lease renewal.

## Decision

| Identity | Scope and advancement |
| --- | --- |
| Commit sequence | Monotonically increasing identity/order within the authoritative store scope. Every committed transaction advances it, including bookkeeping-only commits. Aborted/unpublished work does not establish an authoritative sequence. |
| Spec generation | Per Spec. Advances only for semantic/lifecycle mutations: relevant artifact publication, approval, revision, finding resolution, waiver, revalidation/invalidation, completion transition, or other Spec-authoritative change. |
| Run generation | Per execution run. Advances for committed execution changes: claims, attempts, ownership/fencing, reconciliation, lease state, and run progression. |

A transaction may advance multiple generations when it genuinely changes both domains. Execution bookkeeping alone MUST NOT advance Spec generation. A completion publication that changes the Spec lifecycle is not merely bookkeeping and must satisfy both sets of preconditions.

### Review and human provenance

Human preparation/approval operations bind the observed Spec generation and exact artifact revision/hash set. The authoritative transaction checks those expectations against current Spec state under the store lock. Intervening run-only commits do not invalidate the review; the transaction reads the new HEAD and rechecks semantic expectations instead of treating an old global commit sequence as a review identity.

An approval records decision identity, exact subjects, observed Spec generation, committed applicability, timestamp, actor provenance, and frontend/channel where known. Minimum local actor:

```yaml
kind: human
id: local
```

Channels include `cli` and `pi`; optional display identity may be added later. Cloud identity is not required. The model, worker, and arbitrary Core caller MUST NOT automatically be treated as a human actor. Frontends establish explicit human authorization; Core validates the decision's authority and preconditions.

The approval transaction itself advances Spec generation. Its record MUST identify the reviewed generation and applicability in the resulting committed state, so it does not immediately invalidate itself. Subsequent carry-forward to a permitted generation requires an explicit deterministic applicability decision recorded in committed state, with unchanged exact subjects and no relevant invalidating mutation. This is not a wildcard approval or global `current generation == reviewed generation` check. Independent approvals/consistency analyses can preserve prior exact approvals under these rules; relevant changes revoke applicability and require appropriate review/revalidation.

Quick mode may use one explicit human decision for the exact requirements revision/hash, design revision/hash, task revision/hash, and observed Spec generation. One transaction records each individual artifact's approval applicability and their common decision provenance. A partial integrated approval cannot appear after recovery.

### Claims and runs

A run binds an exact approved Spec snapshot and Spec generation, plus task definition identities. Claims identify task, owner, attempt, run generation/preconditions, bound Spec snapshot, and a fencing token whose replacement cannot reuse an old owner's authority. Lease/capacity checks and claim publication are transactional, not an in-memory ready-set reservation.

Every result publication checks current ownership, fence, attempt, run state, and approved snapshot applicability under authoritative ownership. Expiry, reassignment, reconciliation, cancellation, or supersession can fence an attempt even if its worker still runs. Monotonic fencing identities must not depend solely on wall-clock lease timestamps.

If a relevant Spec mutation supersedes the run's approved snapshot during active work, that mutation MUST revoke old publication authority in the same committed state. Old claims/results cannot publish success into the new Spec state. Historical outputs may be retained with their stale/unknown disposition but do not become current task success. Rebinding work requires explicit validation and new authority, not relabeling a late result as current.

## Consequences

Store order, review applicability, and execution ownership are separate concepts from the first schema. Bookkeeping can proceed during review without weakening stale-decision checks. Lease expiry/fencing prevents authoritative publication, not external side effects; see [ADR-009](009-interrupted-side-effects.md).

## Invariants

INV-GEN-001, INV-GEN-002, INV-GEN-003, INV-APPROVAL-001, INV-APPROVAL-002, INV-APPROVAL-003, INV-EXEC-001, INV-EXEC-002.
