# Aira SDD v2 invariants

Status: accepted, normative. Each `- INV-...: ...` line is one stable review/test identifier. IDs MUST NOT be renumbered or reused; future changes must preserve references and explicitly document supersession. These target rules are not claims that v1 already enforces them. See [architecture](architecture.md) and its ADR index for scope and definitions.

## Spec and boundaries (ADR-001, ADR-004)

- INV-SPEC-001: The Spec lifecycle is Requirements -> Design -> Tasks -> Execution -> Verification -> Completion, with authoring modes distinct from the generic recipe workflow state.
- INV-SPEC-002: The first v2 persistence contract represents the complete required-contract table in architecture.md, including all modes, DAG tasks, parallel claims, and isolated workspace providers; staging execution MUST NOT simplify persisted semantics.
- INV-SPEC-003: Quick mode produces the same canonical requirements, design, and structured tasks and required analyses/validation; only intermediate human gates are removed.
- INV-DOMAIN-001: Spec domain is pure and MUST NOT directly or transitively depend on filesystem/process adapters, Pi SDK, CLI/frontends, or the workflow executor; frontends call Core, not the reverse from domain.

## Behavioral assets and product completeness (ADR-011)

- INV-BUILTIN-001: Every Aira-owned behavioral asset that can materially affect specification generation, analysis, execution, verification, context selection, policy, or user decisions has an immutable versioned identity and content hash.
- INV-BUILTIN-002: A Spec/run pins resolved behavioral asset revisions; changing future defaults cannot change the meaning of previously pinned execution or rewrite historical authoring provenance.
- INV-BUILTIN-003: A missing, unknown, incompatible, or hash-mismatched pinned behavioral asset fails closed before durable use or dispatch; mutable aliases cannot identify persisted execution inputs.
- INV-BUILTIN-004: Project customization is explicit and cannot silently replace an Aira built-in while retaining built-in identity/provenance; only the actual published built-in bytes may retain that published revision's attribution.
- INV-BUILTIN-005: Built-in Spec kinds and modes use explicit production-grade profiles rather than all aliasing one generic minimal behavior; mode configuration cannot override hard Spec lifecycle invariants.
- INV-BUILTIN-006: Behavioral resolution is deterministic and inspectable, resolves defaults to exact pins, and retains all capability restriction layers; child selections cannot widen parent restrictions.
- INV-BUILTIN-007: Built-in assets are independently testable product code; complete production-grade content and its quality tests are required v2 release gates, as specified in release-completeness.md.
- INV-DOC-001: A stable user-facing SDD capability is not release-complete until its conceptual and reference documentation exists; the documentation and end-to-end examples in release-completeness.md are product requirements, not optional polish.

## Storage and generations (ADR-002, ADR-003)

- INV-STORE-001: At every recoverable crash boundary, authoritative state resolves to either the previous committed HEAD or the new committed HEAD, never a partially published aggregate.
- INV-STORE-002: Every writer acquires cross-process ownership and validates expected authoritative state before publishing; atomic rename without ownership and expected-state checks is not transactional CAS.
- INV-STORE-003: Referenced records/artifacts/blobs and the immutable commit are durable before HEAD publication; durable success is acknowledged only after HEAD's directory fsync, and orphan records are not authority.
- INV-STORE-004: Markdown/checkboxes, materialized spec.yaml, approval/event views, and operator displays are not authoritative state; damaged or stale views are rebuildable from committed records, not a sole events.jsonl journal.
- INV-GEN-001: Every committed transaction advances commit sequence; Spec generation and run generation are separate scoped identities, not aliases for storage order.
- INV-GEN-002: Spec generation advances only for Spec semantic/lifecycle mutations; execution bookkeeping or lease renewal alone MUST NOT invalidate unrelated human review.
- INV-GEN-003: Run generation governs claims, attempts, fencing, reconciliation, and run progression; every run binds an exact approved Spec snapshot and Spec generation.

## Human decisions and provenance (ADR-003, ADR-004)

- INV-APPROVAL-001: Human approval is applicable only to exact artifact revision/hash subjects and permitted Spec generation; observed-generation checks and any committed carry-forward are explicit, never wildcard approval.
- INV-APPROVAL-002: Human approval/escalation provenance identifies at least kind=human and id=local plus frontend/channel where known; model, worker, or arbitrary Core caller identity MUST NOT imply human authorization.
- INV-APPROVAL-003: Integrated quick-mode approval is one explicit human decision over the exact requirements/design/tasks revision/hash set and observed Spec generation, atomically recording individual artifact approval applicability.
- INV-LINEAGE-001: Artifact revision identities/content are immutable; derived_from provenance is acyclic and distinct from validated_against applicability records.
- INV-LINEAGE-002: In design-first mode, approved design informs approved requirements and is analyzed against them; unchanged consistent design needs no artificial revision, changed design needs a newly approved revision, and tasks cannot become current before mutual consistency.
- INV-LINEAGE-003: Relevant upstream revisions, findings, waivers, and lifecycle mutations explicitly invalidate/revalidate affected downstream applicability while preserving historical feedback, resolutions, and records.

## Tasks, traceability, and completion (ADR-005, ADR-007)

- INV-TASK-001: A dependent task cannot become ready until every required predecessor is in domain state completed.
- INV-TASK-002: Completed means the task's configured completion policy succeeded with applicable evidence/decisions; a worker returning successfully is insufficient, including for tasks without shell tests.
- INV-TASK-003: Task definitions are an identity-based validated DAG from the first schema; scheduler APIs use task/ready sets, never a sequential cursor, even when max_parallel = 1.
- INV-TASK-004: Existing dependency semantics MUST NOT be weakened to execution-only success; any future execution-only relationship requires a new explicit edge type.
- INV-TRACE-001: Required Requirement -> Acceptance Criteria -> Design Decision -> Task -> Verifier -> Evidence coverage uses stable identities/revision bindings; uncovered MUST obligations block structural completion unless an explicit policy-authorized human waiver exists.
- INV-COMPLETE-001: Completion requires current approved/consistent artifacts, satisfied task completion/traceability/finding policies, and current applicable evidence; relevant invalidation blocks or revokes completion applicability.

## Context, capabilities, and workspaces (ADR-006, ADR-010)

- INV-CONTEXT-001: Context declarations and immutable snapshots define supplied knowledge, not capability grants; attempts bind relevant context and capability policy identities.
- INV-CAP-001: A required hard capability MUST cause execution to fail closed when the selected backend cannot enforce it; prompt advice is not a fallback.
- INV-CAP-002: Capability policy is provider-neutral and deny-wins; exceptional escalation requires explicit human authorization and cannot bypass an unenforceable hard requirement.
- INV-CAP-003: Tool names alone are not security identities; policy/enforcement accounts for actual tool provenance/implementation and canonical/resolved paths at actual I/O boundaries, including traversal and race risks.
- INV-CAP-004: Host-permission arbitrary shell defeats filesystem confinement; Pi tool_call interception alone MUST NOT be claimed to provide process/filesystem/network/environment sandboxing or strong termination.
- INV-WORKSPACE-001: Attempts/evidence bind a provider-neutral, policy/version-identified WorkspaceFingerprint capable of stable content/state identification, including Git repository/base/index/tree/tracked diff/untracked content/provider identities as applicable, not just git status --porcelain.
- INV-WORKSPACE-002: Workspace isolation and execution sandboxing are separate capabilities; worktrees and container labels do not automatically satisfy required backend confinement or force_termination guarantees.
- INV-AGENT-001: AgentRuntime remains provider-neutral and Spec Core has no Pi SDK dependency; current attempts use fresh disposable Pi in-memory sessions, not necessarily fresh OS processes or a strong termination boundary.

## Attempts and evidence (ADR-003, ADR-007, ADR-009)

- INV-EXEC-001: Claim/result publication checks current owner, fencing authority, attempt/run state, and bound approved Spec snapshot transactionally; fenced or superseded late results cannot publish success.
- INV-EXEC-002: A relevant Spec mutation superseding an active run's approved snapshot revokes old claims/results' publication authority into the new Spec state in the same committed mutation.
- INV-EXEC-003: Attempt outcome includes unknown; interruption, lost acknowledgement, cancellation, and transactional metadata MUST NOT imply exactly-once arbitrary external effects or absence of side effects.
- INV-EXEC-004: Unknown replay_safe/idempotent work may retry only by policy, reconcilable work requires reconciliation first, and non_replayable work requires human intervention absent explicit safe reconciliation; undeclared recovery safety cannot authorize automatic replay.
- INV-EVIDENCE-001: Verification evidence cannot satisfy completion against a workspace other than one allowed by its applicability contract; initially any changed fingerprint makes earlier evidence historical, not applicable to the new state.
- INV-EVIDENCE-002: Evidence is immutable and binds verifier ID/revision/hash, Spec artifact revisions, task definition revision, attempt, workspace fingerprint, execution backend identity, timestamps, structured outcome, and output references/hashes.
- INV-EVIDENCE-003: Completion rechecks current evidence/input/policy applicability; future scoped applicability cannot change evidence identity semantics or retroactively broaden historical exact-only evidence.

## Legacy compatibility (ADR-008)

- INV-LEGACY-001: Every valid historical v1 run remains inspectable/readable as read-only v2 compatibility data without regenerating current defaults or requiring safe v1 resume.
- INV-LEGACY-002: V2 MUST NOT fabricate absent historical hashes, overwritten artifacts, exact approvals, old model/config snapshots, prior attempt evidence, or lineage; v1 approval results are not v2 exact-bound approvals.
- INV-LEGACY-003: Migration is explicit, non-destructive, restartable, and provenance-preserving; legacy readers do not import v2 mutation logic or rewrite source history while reading.
