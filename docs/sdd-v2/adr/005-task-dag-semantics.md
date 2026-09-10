# ADR-005: Task DAG and completion-policy dependencies

Status: accepted. Normative for v2.

## Context

A serial implementation must not force a sequential domain model. A successful worker return does not necessarily mean its output is verified or acceptable to downstream work.

## Decision

Task definitions form a structured DAG from the first v2 schema. Tasks have stable identities, immutable definition revisions, explicit dependency references, traceability, and configured completion policies. Graph validation rejects cycles, missing predecessors, and duplicate/ambiguous identities. Definition state and attempt/execution state are distinct.

A dependency is satisfied only when its predecessor has domain state `completed`. That state means the configured completion policy succeeded with currently applicable evidence/decisions. Worker success by itself is insufficient. Failure, interruption, `unknown`, pending human acceptance, and skipped execution do not satisfy a dependency.

Completion policies may require shell verifiers, required artifact publication, static validation, human acceptance, or agent qualitative review where policy permits. Tasks without shell tests still have explicit appropriate completion policies; they are not silently treated as unverified success.

Scheduler APIs operate on task identities, sets, and deterministic ready sets. Readiness requires every required predecessor completed, current applicable task definitions/Spec approval, resolved blocking obligations, and applicable policy preconditions. Capacity and transactional ownership then govern which ready tasks are claimed. Deterministic tie-breaking must be declared rather than inferred from incidental filesystem enumeration.

The initial scheduler policy is `max_parallel = 1`. The persisted model MUST remain parallel-ready: no task cursor as lifecycle truth, no dependency inferred solely from array order, and no claim model limited to a single implicit current task. Future parallel execution and isolated workspaces add scheduling/provider policies, not a new meaning for existing dependencies.

Do not introduce an ambiguous execution-only dependency. If needed later, it must be a new explicit edge type; existing dependencies continue to mean predecessor completion.

## Traceability and completion

Required traceability is structured, using stable domain identities:

```text
Requirement -> Acceptance Criteria -> Design Decision -> Task -> Verifier -> Evidence
```

References also bind relevant revisions so an ID surviving revision does not imply unchanged applicability. Validation checks coverage, not just existence of filenames or Markdown checkboxes. A MUST requirement cannot be structurally complete with uncovered required obligations unless policy permits an explicitly recorded human waiver with scope and provenance.

Spec completion requires current approved/consistent artifacts, completed required tasks, satisfied traceability and finding/waiver obligations, and current applicable verification evidence. A negative/unknown result or stale evidence cannot satisfy a completion policy merely because a worker exited successfully. If relevant mutations invalidate completion, committed applicability changes must block downstream readiness/completion until explicit revalidation or new evidence succeeds.

## Consequences

Keep definitions/schema/graph validation/deterministic readiness in `src/tasks/**`, scheduling ownership/capacity in `src/scheduler/**`, and attempt contracts in `src/execution/**`. The recipe interpreter remains separate. See [ADR-003](003-generation-and-fencing.md) for claims and [ADR-007](007-verification-applicability.md) for evidence.

## Invariants

INV-TASK-001, INV-TASK-002, INV-TASK-003, INV-TASK-004, INV-TRACE-001, INV-EVIDENCE-001, INV-COMPLETE-001.
