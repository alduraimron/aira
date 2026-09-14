# ADR-001: Spec as the primary domain

Status: accepted. Normative for v2. See [architecture](../architecture.md).
The canonical planning ontology is explicitly expanded by [ADR-012](012-canonical-planning-ontology.md); no authority or purity guarantee is relaxed.

## Context

The current application boundary, AiraCore, is useful, and AgentRuntime is provider-neutral. The v1 workflow interpreter describes recipe execution, not the requirements, architecture, traceability, and approval applicability of a Spec.

## Decision

Aira v2 is a deterministic local Spec-Driven Development control plane. Its primary hierarchy is `Intent -> Product Definition -> Requirements -> System Architecture -> Program Design -> Vertical Slice Plan -> Task DAG -> Execution -> Verification -> Completion`. Pi supplies reasoning/execution; humans authorize approval and exceptional capability escalation. Model output is proposed data, not domain authority.

The generic workflow engine remains a lower-level recipe executor and supports standalone operations. Workflow state MUST NOT become the Spec lifecycle, and `src/executor/**` MUST NOT become the Spec scheduler. Frontends call Core application operations/DTOs. Pure Spec domain does not depend on filesystem, Pi SDK, CLI, or workflow execution.

The first persisted v2 schema MUST represent every concept in the architecture's [required-contract table](../architecture.md#first-persistence-contract-required-concepts), including all three authoring modes, immutable artifact identities, stable Product outcome/success/Requirement/AC/Architecture/Program Design/Slice/Task IDs, separate Slice and Task DAGs, traceability, lineage and invalidation, human decisions, analysis findings, snapshots/policies, workspaces/backends, claims/attempts/fencing, verification/evidence, completion, parallel scheduling, and isolated workspace providers. Execution can be staged; the domain model cannot be replaced by a temporary sequential recipe schema.

Human-readable Specs are a product requirement, but Markdown content/checkboxes do not encode authoritative scheduler or completion state. Materialized views project committed structured state.

## Consequences

- Preserve AgentRuntime as the provider/model boundary; Spec Core MUST NOT import Pi SDK types.
- Current worker attempts create a fresh disposable Pi in-memory session, not necessarily an OS process. Session freshness does not establish process isolation or termination guarantees.
- Requirements-first and architecture-first differ in authoring/provenance order, not in final consistency obligations. Quick mode changes human gate placement, not canonical artifact quality.
- Implementation reviews must respect the source boundary table. No empty production directories or speculative runtime implementation are needed to accept this architecture.

## Rejected alternatives

Making workflows the Spec lifecycle, persisting tasks as a cursor for the initial serial executor, or implementing a reduced first schema would make future correctness require reinterpretation of historical v2 data.

## Invariants

INV-SPEC-001, INV-SPEC-002, INV-SPEC-003, INV-DOMAIN-001, INV-AGENT-001, INV-STORE-004.
