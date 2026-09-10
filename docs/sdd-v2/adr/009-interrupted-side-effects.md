# ADR-009: Interrupted attempts and unknown external effects

Status: accepted. Normative for v2.

## Context

A crash, lost acknowledgement, timeout, or cancellation can leave an external operation's outcome uncertain. Transactional metadata publication and fresh sessions do not make arbitrary shell, network, or other external effects exactly-once.

## Decision

Attempt outcome includes explicit `unknown`, distinct from known failure, known success, and interruption/cancellation intent. Record attempts and recovery decisions rather than overwriting all history with a retry counter. A stop request does not prove that the operation did nothing, that descendants stopped, or that a side effect rolled back.

Operations, verifiers, and execution profiles may declare recovery characteristics and their applicable scope/assumptions:

| Characteristic | Required handling after unknown outcome |
| --- | --- |
| `replay_safe` | May retry according to policy when repetition is safe within the declared scope. |
| `idempotent` | May retry according to policy with the required stable operation identity/idempotency key and declared guarantees. |
| `reconcilable` | MUST reconcile observed external state before further action; only the reconciled disposition/policy can authorize another attempt or completion. |
| `non_replayable` | Requires human intervention unless an explicit safe reconciliation mechanism exists. |

Absent or unproven recovery characteristics MUST NOT authorize automatic replay. If several declarations apply, all required safeguards must hold; do not choose the weakest. Reconciliation is itself an explicit, provenance-bearing operation with evidence and outcome, not an inference that a missing local result means no effect.

On interruption/lost ownership, fence publication authority transactionally and record known/unknown disposition. Reconcile or retry only under current claim/fence and approved Spec snapshot. Preserve old attempts' identities. Late results from fenced or superseded attempts MUST NOT publish success, complete a task, or satisfy downstream dependencies. Historical retention does not restore authority.

Storage transaction identity can resolve whether a metadata transaction committed. It cannot resolve arbitrary external effects unless a declared safe external reconciliation/idempotency mechanism provides that information. Claim leases provide ownership/publication control, not proof that a stale process ceased producing effects.

## Consequences

Recovery APIs must return explicit manual-intervention/reconciliation requirements rather than a universal resume button. The initial serial scheduler still needs these contracts in persistence. Strong process termination may require a supervised ExecutionBackend outside Pi's fresh in-memory session boundary, and even successful termination does not reverse effects already performed.

This change documents the target only; it does not alter existing v1 interruption or retry behavior. See [ADR-003](003-generation-and-fencing.md) and [ADR-010](010-workspace-and-execution-backends.md).

## Invariants

INV-EXEC-001, INV-EXEC-002, INV-EXEC-003, INV-EXEC-004, INV-AGENT-001.
