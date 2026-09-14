# ADR-012: Explicit Product, Architecture, Program Design and Vertical Slices

Status: accepted, normative stage 05B evolution requested before runtime integration.

## Context

The pre-release generic Design contract conflated system organization with intended
code structure. Requirements lacked explicit Product intent, and a Task DAG alone
provided no end-to-end review increments. Storage already correctly preserves exact
bytes and immutable identities. This is an ontology evolution, not a storage rollback.

## Decision

The canonical hierarchy is:

```text
Intent -> Product Definition -> Requirements -> System Architecture -> Program Design
       -> Vertical Slice Plan -> Task DAG -> Execution -> Verification -> Completion
```

Each planning layer is an independently revisioned canonical artifact. See the
[planning model](../planning-model.md) for structure, provenance, policy and APIs.
Product intent is not synonymous with a Requirement. Architecture owns system
boundaries; Program Design owns intended code structure. A Slice is an observable,
reviewable, verifiable end-to-end increment, not a task group or horizontal layer.

All executable tasks have exactly one Slice owner, represented in the Task and Slice
Plan with checked reciprocal membership. Slice and Task dependencies are separate
DAGs. Cross-Slice Task prerequisites must follow transitive Slice ordering. Lexical
sorting is only deterministic diagnostic/ready-set presentation, never a dependency.

Slice execution state is separate from its definition, bound to an exact Slice Plan
reference and run. Readiness requires applicable planning, approvals and findings,
and completed predecessor Slices. Task readiness additionally requires explicit active
Slice selection and completed task prerequisites. There is no activation or scheduler
implementation. Completion rechecks task policies, selected applicable Slice evidence,
predicates and configured human checkpoints. A worker success is not sufficient.

One shared finding infrastructure supports artifact, semantic-entity and relationship
targets. Product, Architecture, Program Design and Slice semantic quality concerns are
representable; no LLM analyzer or claim of deterministic semantic quality is introduced.

## Pre-release contract retirement, not reinterpretation

Remove the generic `Design` API, `D*` registry identity and `aira.dev/design/v1` from
canonical domain/storage dispatch. Its old meaning is not reused by either new schema.
No old generic-design state is accepted as canonical. No implicit conversion exists.

Choose authoring-mode option A: introduce `architecture-first`, retire the pre-release
`design-first` contract. Architecture-first proposes Architecture from Product, derives
Requirements from Product plus Architecture, then separately validates Architecture
against Requirements. `validated_against` never rewrites `derived_from`. Unchanged
Architecture keeps its content revision and original authoring profile/approval; current
consistency and approval carry-forward remain exact-bound independent records.

Affected existing domain contracts advance to their own `/v2` identifiers, including
the aggregate Spec, artifact envelope, Requirements, analyses, tasks, decisions and
transitively affected execution/behavioral records. New planning artifacts start at
new `/v1` identifiers. Unaffected contracts retain their original identities. The
[explicit version inventory](../planning-model.md#development-state-incompatibility)
is authoritative. Unknown/retired schemas fail closed. Developer fixtures are newly
authored synthetic data, not conversions or claims of historical provenance.

Existing pre-release stores containing retired records are deliberately unsupported by
this decoder. Preserve them for inspection with their original checkout if needed; new
canonical Specs require new authoring in a separate development store. Do not rewrite
hashes, change FORMAT in place, or silently reinterpret a HEAD. This is not promised
public backward compatibility for an unreleased development format.

The file-store FORMAT, canonical JSON, BlobStore, immutable commit publication, HEAD,
CAS, generation separation, locks and crash protocol are unchanged. Storage dispatch and
reference closure now validate the new contracts. Frozen v1 history and migration rules
are unchanged; `plan.md` cannot fabricate any of these planning artifacts.

## Behavioral and policy consequences

Twelve explicit generation/analysis roles cover the six planning phases. Old generic
design roles are retired, not silently assigned new semantics. Previously published
asset identity/version/hash immutability rules still hold. Kind and mode selections can
specialize all phases; profiles cannot disable structural planning or quality gates.
Quick authors all six artifacts and analyses, with one exact six-subject approval.
Production prompt/skill/profile content remains a separate required release gate.

Fine-grained derivation scopes may pin stable semantic IDs and measured hashes. Missing
or unverified scope observations fail closed; unchanged scoped inputs may preserve
applicability across unrelated upstream changes. Artifact approvals still bind complete
exact revision/hash subjects and explicitly carried Spec generations. No scoped evidence
reuse or automatically transferable approval is introduced.

Project Steering remains excluded. Future Context snapshots can supply exact Steering
inputs without collapsing the six artifacts or reinterpreting their identities.

## Relationship to earlier ADRs and invariants

This explicitly evolves the planning vocabulary and artifact cardinalities in ADRs
001, 003, 004, 005, 007 and 011. Their authority, exact approval, acyclic provenance,
completed-prerequisite, evidence and immutable asset guarantees are retained and
strengthened. No storage, capability, workspace, recovery or legacy invariant is relaxed.
INV-SPEC-001/003, INV-APPROVAL-003, INV-LINEAGE-002 and INV-TRACE-001 retain their IDs
with their expanded canonical coverage. Add INV-PRODUCT-001, INV-ARCH-001,
INV-PROGDESIGN-001, INV-SLICE-001 through INV-SLICE-004 and INV-TRACE-002.
