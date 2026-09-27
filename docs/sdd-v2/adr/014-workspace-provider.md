# ADR-014: Exact WorkspaceProvider provenance and fenced lifecycle

Status: accepted target decision for Stage 06; implementation deferred. [Master contract](../workspace-contract.md) is normative for exact semantics. Extends [ADR-010](010-workspace-and-execution-backends.md), not a replacement for its backend/security distinction.

## Context

The preliminary v2 workspace handle identifies a provider/location, and the fingerprint contract records repository/content components. Neither establishes which reviewed dirty source state a prepared workspace includes, separates control from execution roots, registers a restorable base, or governs concurrent ownership and cleanup. Run-task fencing in [ADR-003](003-generation-and-fencing.md) protects run authority but not a shared mutable execution tree. An isolated directory is not process confinement.

## Decision

1. Separate trusted control-root authority from worker-visible execution-root project content even when a selected in-place topology makes the paths equal. Workspaces are provider-neutral; Git worktrees are one strategy.
2. Mint durable control-project, project/repository, workspace, incarnation, source/base, fingerprint, workspace-claim and workspace-fence identities separately. An immutable handle pins one incarnation, provider semantics, exact base and overlay decision, both operational root references, capability contract, creation provenance and WorkspaceStore authority key. Paths are not semantic identity.
3. Require an exact reviewed source observation and explicit `require-clean`, `base-only` or `include-observed-overlay` choice. Dirty material is never silently dropped or included. Changed source fails preparation by default. Non-Git prepare needs a retained immutable snapshot base; a fingerprint is not a restorable snapshot.
4. Fingerprint canonical project-content state with a pinned capture policy and SHA-256, including distinct Git index and working-tree observations, covered untracked/ignored files, symlinks, modes, deletions and empty directories. Exclude host control `.aira/**` and Git metadata from the default *content* identity; separately bind exact control inputs and repository semantics. No status/mtime identity and no digest-only cross-policy comparison.
5. Introduce a provider-neutral WorkspaceStore with its own authoritative CAS/HEAD, immutable handle history, lifecycle transitions, OperationId replay and per-workspace monotonically increasing fence. Use durable exclusive claims plus explicit recovery, not expiring workspace TTLs. Recovery preserves ambiguous work and cannot authorize stale lifecycle publication; it does not stop running processes.
6. Keep run claim and workspace claim separate. Effective dispatch/results require both, with a future short-lock order of workspace then Spec and exact dual-authority checks; partial cross-store commits never authorize execution. No cross-store atomicity is claimed. Before that coordinator exists, dispatch/result integration fails closed.
7. Retain on uncertain outcome; dispose only after exact registered resource/fence and scope verification. Never delete a path solely from untrusted handle data. In-place disposal never removes the control project. Unsupported Git/nested/submodule/non-Git or unsafe path cases fail explicitly.
8. Advertise only workspace-level capabilities. Topology isolation is not write confinement or security isolation. Capability Engine and ExecutionBackend enforce worker restrictions; Verification Runner establishes observation interval and outcome; Scheduler decides readiness.

## Alternatives rejected

- Treating `location` or `.git`/directory existence as workspace authority loses identity on moves, replacement and orphans.
- Auto-stealing after a TTL/PID failure can transfer a live tree to two writers. Durable claim with fenced explicit recovery can quarantine uncertain work without permanent global blockage; a different workspace may be prepared from known material.
- Storing lifecycle under a Spec or Steering registry creates the wrong ownership scope and cross-Spec collision risk. Distinct WorkspaceStore authority avoids masquerading as either; coordination with SpecStore is explicit, not an imaginary atomic transaction.
- Implicitly ignoring Git dirty/ignored files or treating a SHA-256 fingerprint as a snapshot loses exact preparation/evidence provenance.
- Describing a worktree/in-place project as a sandbox contradicts ADR-006/010 and cannot restrain an arbitrary OS process.

## Consequences and version evolution

The existing `aira.dev/workspace-handle/v1`, `workspace-fingerprint/v1`, `workspace-observation/v1` and dependent attempt/context/evidence contracts are preliminary v2 schemas, not implementations of this target. Their historical bytes/meaning MUST NOT be silently upgraded in place. 06-1 and later slices version new contracts, update store dispatch and dependent binding validation as needed, and fail unavailable semantics closed. WorkspaceStore and cross-store coordinator are not implemented by this ADR. No Stage 06 runtime, Git operation or sandbox is added here.

Stage 05C's trusted-control-root, local-filesystem, pathname-race and distributed-consistency limitations remain. Stronger path/process isolation needs certified kernel/backend mechanisms, not a provider label. This ADR adds no promise to authenticate a human actor or prevent coherent malicious control-store rollback.

## Invariants

Existing INV-WORKSPACE-001/002 retain their original meanings. See INV-WORKSPACE-003 through INV-WORKSPACE-015 and INV-EVIDENCE-001/002, INV-EXEC-001/003, INV-CAP-001/004, INV-STORE-001/002. The Stage 06 minimum set maps to stable IDs without reusing them:

| Requested Stage 06 rule | Stable ID |
| --- | --- |
| Control/execution roles | INV-WORKSPACE-003 |
| Mutating attempt bindings | INV-WORKSPACE-004 |
| Deterministic fingerprint | INV-WORKSPACE-005 (and existing 001) |
| Exact base/overlay | INV-WORKSPACE-006 |
| Exclusive mutating claim | INV-WORKSPACE-007 |
| Recovery fencing | INV-WORKSPACE-008 |
| Topology is not sandboxing | Existing INV-WORKSPACE-002 |
| Fail-closed disposal | INV-WORKSPACE-009 |
| Exact verification applicability | INV-WORKSPACE-010 |
| Directory is not authority | INV-WORKSPACE-011 |

INV-WORKSPACE-012 through 015 add freshness, control-state exclusion, dual-store coordination and manual reconciliation.
