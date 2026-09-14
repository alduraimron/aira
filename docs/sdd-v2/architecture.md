# Aira SDD v2 architecture

Status: accepted, normative target contract for all v2 work.

This directory defines the complete v2 architecture, even where implementation is staged. The first v2 persistence schema MUST represent this contract; a temporary simplified schema is not an acceptable implementation slice. Pure domain contracts implement these decisions ahead of adapters. They do not implement Spec execution, transactional storage, migration, or a sandbox, and do not change current production behavior.

[Current runtime architecture](../architecture.md) describes v1, not competing v2 lifecycle rules. MUST, MUST NOT, and REQUIRED below are normative. Reviews and future tests should cite the [stable invariants](invariants.md) and relevant ADR. A concrete technical impossibility must be reported before implementing a contradictory portion; staging alone is not grounds to redesign these decisions.

## Identity and authority

Aira v2 is a deterministic local Spec-Driven Development control plane:

```text
Intent -> Product Definition -> Requirements -> System Architecture -> Program Design -> Vertical Slice Plan -> Task DAG -> Execution -> Verification -> Completion
```

This is the primary domain hierarchy, not a requirement that authoring always starts with requirements. Pi is a reasoning/execution adapter. Human users retain authority over approval and exceptional capability escalation. Deterministic domain rules, not model assertions, decide applicability, readiness, and completion.

The generic workflow engine remains available as a lower-level recipe executor and for standalone operations. Workflow state is not the Spec lifecycle. AiraCore remains the application boundary; frontends call Core, and Core coordinates domain decisions and infrastructure through ports. Spec Core MUST NOT depend on Pi SDK types.

## First persistence contract: required concepts

These are required representational capabilities from the first v2 schema, not optional future migrations. Exact field spelling and serialization are deferred to implementation ADRs consistent with this contract.

| Area | Required representation |
| --- | --- |
| Spec lifecycle | Requirements-first, architecture-first, and quick modes; intent; current/proposed/superseded applicability; completion state |
| Canonical artifacts | Product Definition, Requirements, System Architecture, Program Design, Vertical Slice Plan, Task DAG; distinct schemas and immutable revision/hash identities; stable O/SC/R/AC/A/PD/S/T/V IDs and tombstones |
| Behavioral assets | Immutable versioned Aira/project asset identities, content hashes, provenance, compatibility, bundle manifests, closed role selections, kind/mode profiles, exact pins and phase-specific Spec/run/attempt attribution; never mutable filenames/default aliases |
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

- Product intent precedes all authoring. Requirements-first derives Architecture from current Requirements, then Program Design, Slices and Tasks. Architecture-first proposes Architecture from Product before Requirements. See the normative [planning model](planning-model.md) and [ADR-012](adr/012-canonical-planning-ontology.md). Architecture-first proposes and approves architecture, derives and approves Requirements using Product plus Architecture, then analyzes that same architecture against requirements. Unchanged consistent architecture needs no duplicate content revision; changed architecture needs a new approved revision. Tasks become current only with mutually consistent requirements and applicable architecture. See [ADR-004](adr/004-design-first-provenance.md).
- Quick mode creates the same canonical Product, Requirements, Architecture, Program Design, Slice Plan, and Task Plan and performs the same required analyses/validation. It removes intermediate human gates, not quality or traceability obligations. One final explicit human decision may approve the exact revision/hash set plus observed Spec generation in one transaction, recording individual artifact applicability.
- Revision feedback, findings, waivers, and revalidation are first-class Spec state. A relevant upstream mutation invalidates affected downstream approval, task, run, evidence, and completion applicability without deleting history. Revalidation is explicit and exact-bound, not silent reuse by filename.
- Traceability supports `Product Outcome -> Success Criterion -> Requirement -> Acceptance Criterion -> Architecture Decision -> Program Design Decision -> Slice -> Task -> Verifier -> Evidence`. A MUST requirement cannot be structurally complete with uncovered required obligations unless policy permits and records an explicit human waiver. Completion also requires current applicable evidence and satisfied completion policies.
- Slices and Tasks form separate DAGs. Every executable Task has exactly one Slice owner. Cross-Slice Task prerequisites follow the transitive Slice order. Slice completion requires Task policies and current passing Slice verification/checkpoints, never worker success. Tasks form a DAG. A dependency means predecessor domain state `completed`, which requires its configured completion policy, not worker success. Readiness operates on identities/sets, never a persisted sequential cursor. Initial execution policy is `max_parallel = 1`; definitions remain parallel-ready. See [ADR-005](adr/005-task-dag-semantics.md).
- Approval/preparation binds exact artifacts and observed Spec generation. Human provenance requires at least `{ kind: human, id: local }` and channel (`cli`, `pi`) where known; no cloud identity is required. A worker, model, or arbitrary Core caller is not automatically a human. See [ADR-003](adr/003-generation-and-fencing.md).

## Versioned behavioral assets and release quality

Aira-owned prompts, analyses, skills, kind/mode/context/capability/verification/execution
profiles and recipes are independently testable **product code**, separate from generated
Spec artifacts. Published revisions are immutable, content-hash identified, provenance
recorded and pinnable. Project overrides are explicit project-owned selections for logical
roles, not replacement bytes masquerading as the original built-in. See
[ADR-011](adr/011-versioned-behavioral-assets.md).

Pure deterministic resolution produces inspectable exact pins before durable use.
Ordinary precedence is task (only allowed roles), Spec, kind, mode, then bundle defaults;
capability restrictions instead retain every layer with existing deny-wins composition.
Profiles cannot override lifecycle or backend enforcement invariants. Unknown, missing,
incompatible or hash-mismatched pinned revisions fail closed without fallback.

Specs preserve phase-specific immutable profile snapshots in output lineage, including
all twelve generation/analysis activities. Approved run snapshots, attempts, context and
evidence preserve exact behavioral references. Future default changes never rewrite
existing pins. Profile adoption is a controlled Spec semantic mutation subject to existing
generation, invalidation and fencing rules. Revalidating unchanged architecture-first content
may use a new analysis profile without changing its original authoring snapshot.

Production-grade content, differentiated kinds/modes, independent content tests,
conceptual/reference user documentation and end-to-end examples are REQUIRED release
gates, not optional post-MVP polish. The complete minimum library/documentation/example
checklist is [release-completeness.md](release-completeness.md). Recording that checklist
does not implement prompts, skills, templates, content loading or Pi integration.

## Publication, execution, and recovery

One authoritative HEAD selects an immutable committed aggregate. Lock/ownership, expected-state checks, durable immutable records, and atomic HEAD advancement provide transactional publication. Independently replacing `spec.yaml`, approval/artifact files, and `events.jsonl` does not. Markdown and YAML views, Markdown checkboxes, operator displays, and event views are derived, rebuildable, and non-authoritative. See [ADR-002](adr/002-transactional-file-store.md).

Stage 4 implements the file-backed persistence foundation described in the
[storage contract](storage-contract.md), including exact encodings, provider-neutral
ports, immutable blobs/commits, HEAD CAS, process locks, explicit recovery and platform
limitations. This does not connect workers, scheduling or frontends. Stage 5 adds the
[frozen compatibility and pure migration contract](compatibility-migration-contract.md)
and an [adversarial storage audit](storage-audit-stage5.md), without an import executor.

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
| `src/builtins/**` | Pure behavioral asset identities, revisions, provenance, typed role/profile selection, bundle manifests, exact pins, compatibility and deterministic resolution; no content loading or generated Spec artifacts |
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
| `src/storage/file/**` | File-backed lock/CAS/commit/blob/recovery implementation; see [storage contract](storage-contract.md) |
| `src/legacy/v1/**` | Frozen read-only historical schema, reader, observations and projections; MUST NOT import mutable v1 runtime or v2 mutation logic |
| `src/migration/**` | Pure inspect/plan/preflight/archive-proposal/report; future execution through a dedicated transactional archive port, never fake SpecStore records |
| `src/compatibility/**` | Provider-neutral format/query composition above distinct v1 and v2 read contracts; concrete file composition stays separate |
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
4. [Architecture-first provenance](adr/004-design-first-provenance.md)
5. [Task DAG semantics](adr/005-task-dag-semantics.md)
6. [Capability enforcement](adr/006-capability-enforcement.md)
7. [Verification applicability](adr/007-verification-applicability.md)
8. [V1 compatibility](adr/008-v1-compatibility.md)
9. [Interrupted side effects](adr/009-interrupted-side-effects.md)
10. [Workspace and execution backends](adr/010-workspace-and-execution-backends.md)
11. [Versioned built-in assets and behavioral profiles](adr/011-versioned-behavioral-assets.md)
12. [Canonical planning ontology and explicit pre-release schema retirement](adr/012-canonical-planning-ontology.md)
