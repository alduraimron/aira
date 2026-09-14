# ADR-007: Immutable evidence and conservative applicability

Status: accepted. Normative for v2.

## Context

Historical test output is not proof about a changed workspace. A verifier returning success must also be identifiable, authorized, and applicable to the current Spec, task, attempt, and repository state.

## Decision

Verification profiles define required revisioned verifiers, structured outcomes, completion policy integration, and execution/recovery requirements. Evidence is immutable historical data with a stable identity. Every evidence record binds at least:

| Binding | Required meaning |
| --- | --- |
| Verifier | Verifier ID and exact verifier revision/hash, not just a command label |
| Spec inputs | Exact Spec artifact revisions and their integrity identities |
| Task | Exact task definition revision and task attempt identity |
| Workspace | Provider-neutral WorkspaceFingerprint identifying the evaluated state |
| Backend | Execution backend identity, including relevant configuration/implementation identity |
| Time | Execution/observation timestamps sufficient to establish the evidence interval |
| Outcome | Structured success/failure/unknown or other declared non-success disposition; no success inferred from prose |
| Outputs | Immutable output references and content hashes, including relevant diagnostic/artifact outputs |

Evidence records the observation even when negative, stale, or interrupted. Changing applicability does not mutate the observation or mint a false historical result. Late evidence may be retained as history but cannot bypass attempt fencing.

### Initial applicability

Use conservative **exact workspace applicability**. If the workspace fingerprint changes after verification, earlier evidence remains historical but is not applicable to the new current workspace state. Completion requires current applicable evidence, not the latest successful log entry.

The applicability check also verifies current exact Spec inputs, task definition, attempt authority, verifier/profile policy, and relevant backend requirements. A matching workspace fingerprint alone is not sufficient after those inputs change. Evidence spanning an uncharacterized concurrent workspace mutation cannot assert a verified stable state. The workspace/backend/runner contract must establish which state was evaluated and recheck it before completion publication; inability to establish that binding blocks completion.

The schema permits future explicitly scoped applicability (for example, declared verified input scope and applicability-contract version), without changing evidence identity semantics or retroactively broadening old exact-only records. The initial evaluator must reject unsupported applicability contracts rather than assuming they are exact or universally valid.

### Traceability and completion

Evidence connects to verifiers/tasks/Slices/Program Design/Architecture/ACs/Requirements/Product intent through structured exact-bound references under [ADR-012](012-canonical-planning-ontology.md). Slice-level evidence remains immutable and task/attempt-bound; exact current selected observations must cover the Slice's verifier/predicate/checkpoint obligations. Required obligations cannot be satisfied by unrelated successful checks. Findings and policy-authorized human waivers are explicit records, not evidence fabricated to make a task green.

A completion transaction rechecks applicable evidence and required policies against current authoritative state and a valid current workspace observation. Workspace drift or relevant Spec changes invalidate completion applicability; history remains inspectable. Authoritative metadata CAS alone does not freeze an externally mutable workspace, so provider execution coordination must support the claimed observation boundary.

## Consequences

Initial invalidation is intentionally conservative. Scoped reuse is a future policy/evaluator extension, not an excuse to omit workspace identity in the first schema. [ADR-010](010-workspace-and-execution-backends.md) defines fingerprint requirements; [ADR-009](009-interrupted-side-effects.md) governs unknown verifier effects.

## Invariants

INV-EVIDENCE-001, INV-EVIDENCE-002, INV-EVIDENCE-003, INV-WORKSPACE-001, INV-COMPLETE-001, INV-TRACE-001.
