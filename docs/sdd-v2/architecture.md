# Aira SDD v2 architecture

Status: accepted, normative target contract for all v2 work.

This directory defines the complete v2 architecture, even where implementation is staged. The first v2 persistence schema MUST represent this contract; a temporary simplified schema is not an acceptable implementation slice. This change freezes decisions and v1 evidence only. It does not implement Spec execution, transactional storage, migration, or a sandbox, and does not change current production behavior.

[Current runtime architecture](../architecture.md) describes v1, not competing v2 lifecycle rules. MUST, MUST NOT, and REQUIRED below are normative. Reviews and future tests should cite the [stable invariants](invariants.md) and relevant ADR. A concrete technical impossibility must be reported before implementing a contradictory portion; staging alone is not grounds to redesign these decisions.

## Identity and authority

Aira v2 is a deterministic local Spec-Driven Development control plane:

```text
Spec -> Requirements -> Design -> Tasks -> Execution -> Verification -> Completion
```

This is the primary domain hierarchy, not a requirement that authoring always starts with requirements. Pi is a reasoning/execution adapter. Human users retain authority over approval and exceptional capability escalation. Deterministic domain rules, not model assertions, decide applicability, readiness, and completion.

The generic workflow engine remains available as a lower-level recipe executor and for standalone operations. Workflow state is not the Spec lifecycle. AiraCore remains the application boundary; frontends call Core, and Core coordinates domain decisions and infrastructure through ports. Spec Core MUST NOT depend on Pi SDK types.

## First persistence contract: required concepts

These are required representational capabilities from the first v2 schema, not optional future migrations. Exact field spelling and serialization are deferred to implementation ADRs consistent with this contract.

| Area | Required representation |
| --- | --- |
| Spec lifecycle | Requirements-first, design-first, and quick modes; intent; current/proposed/superseded applicability; completion state |
| Canonical artifacts | Requirements, design, structured tasks; immutable revision identities including content hashes; stable requirement, acceptance-criterion, and design-decision IDs; stable task identities with revisioned definitions |
| Relationships | Typed lineage (`derived_from` distinct from `validated_against`); traceability; downstream invalidation and recorded revalidation |
| Human decisions | Exact-bound approvals, revision requests/feedback/resolutions, policy-authorized waivers, actor and channel provenance |
| Analysis | Immutable findings/results bound to analyzed revisions; finding severity/policy obligations, resolution and applicability |
| Execution inputs | Context declarations and immutable snapshots; capability policy identities/revisions; workspace identity/fingerprint and provider identity |
| Runs | Exact approved Spec snapshot and Spec generation; attempts and explicit outcomes including `unknown`; execution backend identities and recovery characteristics |
| Scheduling | DAG dependencies, task sets/ready sets, capacity, claims, ownership/leases, fencing, run generation; future parallel scheduling without a sequential cursor |
| Verification | Verification profiles and revisioned verifiers, completion policies, immutable evidence/output hashes and applicability |
| Persistence | Authoritative commit sequence, separated Spec/run generations, transaction identity/preconditions, immutable referenced records and one HEAD publication point |
| Providers | Provider-neutral workspace handles, future isolated workspace providers and execution backends with explicit enforceable capabilities |

An immutable artifact identity identifies a particular revision and its exact content hash, not just a filename or display version. Stable domain IDs survive content revision and MUST NOT be silently reassigned to unrelated obligations. Applicability changes are separate committed records; immutable historical content is not edited in place. Context describes knowledge supplied, not permission to access it.

## Lifecycle and safety

- Requirements-first derives design from current requirements. Design-first proposes and approves design, derives and approves requirements using intent plus design, then analyzes that same design against requirements. Unchanged consistent design needs no duplicate content revision; changed design needs a new approved revision. Tasks become current only with mutually consistent requirements and applicable design. See [ADR-004](adr/004-design-first-provenance.md).
- Quick mode creates the same canonical requirements, design, and structured tasks and performs the same required analyses/validation. It removes intermediate human gates, not quality or traceability obligations. One final explicit human decision may approve the exact revision/hash set plus observed Spec generation in one transaction, recording individual artifact applicability.
- Revision feedback, findings, waivers, and revalidation are first-class Spec state. A relevant upstream mutation invalidates affected downstream approval, task, run, evidence, and completion applicability without deleting history. Revalidation is explicit and exact-bound, not silent reuse by filename.
- Traceability supports `Requirement -> Acceptance Criteria -> Design Decision -> Task -> Verifier -> Evidence`. A MUST requirement cannot be structurally complete with uncovered required obligations unless policy permits and records an explicit human waiver. Completion also requires current applicable evidence and satisfied completion policies.
- Tasks form a DAG. A dependency means predecessor domain state `completed`, which requires its configured completion policy, not worker success. Readiness operates on identities/sets, never a persisted sequential cursor. Initial execution policy is `max_parallel = 1`; definitions remain parallel-ready. See [ADR-005](adr/005-task-dag-semantics.md).
- Approval/preparation binds exact artifacts and observed Spec generation. Human provenance requires at least `{ kind: human, id: local }` and channel (`cli`, `pi`) where known; no cloud identity is required. A worker, model, or arbitrary Core caller is not automatically a human. See [ADR-003](adr/003-generation-and-fencing.md).

## Publication, execution, and recovery

One authoritative HEAD selects an immutable committed aggregate. Lock/ownership, expected-state checks, durable immutable records, and atomic HEAD advancement provide transactional publication. Independently replacing `spec.yaml`, approval/artifact files, and `events.jsonl` does not. Markdown and YAML views, Markdown checkboxes, operator displays, and event views are derived, rebuildable, and non-authoritative. See [ADR-002](adr/002-transactional-file-store.md).

Commit sequence orders every committed transaction. Spec generation changes only for Spec semantic/lifecycle mutations. Run generation governs execution bookkeeping, claims, attempts, reconciliation, and fencing. Lease renewal does not invalidate unrelated review. A run binds an exact approved Spec snapshot; superseding relevant Spec state fences old claims/results. See [ADR-003](adr/003-generation-and-fencing.md).

Evidence is immutable and binds verifier revision/hash, Spec artifact revisions, task definition revision, attempt, workspace fingerprint, backend, timestamps, outcome, and output references/hashes. Initially only an exactly matching workspace fingerprint is applicable; changed workspace state makes prior evidence historical, not current completion evidence. Future scoped applicability must preserve evidence identity semantics. See [ADR-007](adr/007-verification-applicability.md).

Capability policy is provider-neutral, deny-wins, and fail-closed. Tool implementation/provenance matters, and resolved paths must be enforced at actual I/O boundaries. Host-permission arbitrary shell defeats filesystem confinement; Pi `tool_call` hooks are not a shell sandbox. Required hard backend capabilities cannot degrade into prompt advice. Workspace isolation is separate from process sandboxing. See [ADR-006](adr/006-capability-enforcement.md) and [ADR-010](adr/010-workspace-and-execution-backends.md).

Current Aira worker attempts create fresh disposable Pi **in-memory sessions**, not necessarily fresh OS processes. AgentRuntime remains provider-neutral. Strong termination may require a supervised backend outside that in-process boundary. Interrupted external effects may have an `unknown` outcome, with retries/reconciliation/human intervention governed by declared recovery characteristics, never an exactly-once promise. See [ADR-009](adr/009-interrupted-side-effects.md).

## Locked source boundaries

This is the target dependency direction, not a request to create empty directories or relocate v1 code now. Shared pure types/contracts may be consumed inward; infrastructure implements ports outward. Domain code MUST NOT transitively import filesystem/process adapters, Pi, frontends, or the recipe executor through an allegedly neutral module. Use separate pure contract modules from effectful implementations within each area.

```text
CLI / Pi frontend -> Core application -> domain decisions + provider-neutral ports
                                            ^
                         storage / workspace / execution / Pi adapters implement ports
```

| Source boundary | Responsibility and dependency constraints |
| --- | --- |
| `src/spec/domain/**` | Pure Spec domain; no filesystem, Pi, CLI, or workflow executor imports |
| `src/tasks/**` | Task definitions/schema, graph validation, deterministic readiness; pure definitions separate from execution effects |
| `src/approval/**` | Keep legacy generic recipe approvals separate from v2 Spec approval records/applicability; no automatic conversion between them |
| `src/revision/**` | Spec revision requests/resolutions and downstream invalidation semantics |
| `src/context/**` | Context declarations and immutable snapshots; not capability grants |
| `src/capabilities/**` | Provider-neutral policy model/compiler and path/tool/process requirements |
| `src/verification/**` | Profiles, evidence, applicability, runner contracts; effectful runners use execution/workspace ports |
| `src/execution/**` | Attempts, outcomes, fencing, retry/recovery contracts |
| `src/scheduler/**` | Ready set, claims, capacity, ownership; deterministic selection plus transactional claims through store ports |
| `src/workspace/**` | `WorkspaceHandle`, `WorkspaceFingerprint`, provider capabilities and adapter contracts |
| `src/storage/**` | Store ports and transactional contracts, not filesystem details in domain types |
| `src/storage/file/**` | Eventual lock/CAS/commit/blob/recovery implementation |
| `src/legacy/v1/**` | Eventual frozen v1 reader/projection; MUST NOT import v2 mutation logic |
| `src/migration/**` | Explicit inspect/plan/import/report; provenance-preserving import through v2 application/store contracts |
| `src/workflow/**` | Generic recipe definitions, not the Spec lifecycle model |
| `src/executor/**` | Recipe interpreter, not the Spec scheduler |
| `src/agent/**` | Provider-neutral worker boundary (`AgentRuntime`); no Pi SDK in exported domain contracts |
| `src/agent/pi/**` | Pi-specific worker/session/tool/model enforcement |
| `src/core/**` | Application operations and DTOs; frontends call Core; domain does not call frontends |
| `src/cli/**`, `src/pi/**` | Presentation, authorization, cancellation wiring |
| `src/observability/**` | Operator display, not authoritative audit/evidence |

## V1 history and staged delivery

Every valid historical v1 run MUST remain inspectable/readable, even without its old workflow or configuration. V2 treats it as read-only compatibility data; safe v1 resume is not required. Do not invent hashes, overwritten versions, approval identities, config/model snapshots, missing attempt evidence, or lineage. Migration is explicit, non-destructive, restartable, and provenance-preserving. See [ADR-008](adr/008-v1-compatibility.md) and the [frozen fixture corpus](../../tests/fixtures/legacy-v1/README.md).

The existing v1 atomic replacement, mutable artifact paths, generic approvals, sequential recipe executor, and unsandboxed local runtime are baseline limitations, not v2 implementations of these contracts. Later slices may defer execution features but MUST NOT persist a weaker lifecycle, cursor-only task model, fake transactions, or unenforceable hard policy. This documentation changes none of those v1 behaviors.

## ADR index

1. [Spec as primary domain](adr/001-spec-as-primary-domain.md)
2. [Transactional file store](adr/002-transactional-file-store.md)
3. [Generation and fencing](adr/003-generation-and-fencing.md)
4. [Design-first provenance](adr/004-design-first-provenance.md)
5. [Task DAG semantics](adr/005-task-dag-semantics.md)
6. [Capability enforcement](adr/006-capability-enforcement.md)
7. [Verification applicability](adr/007-verification-applicability.md)
8. [V1 compatibility](adr/008-v1-compatibility.md)
9. [Interrupted side effects](adr/009-interrupted-side-effects.md)
10. [Workspace and execution backends](adr/010-workspace-and-execution-backends.md)
