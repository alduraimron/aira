# Canonical Spec planning model

Status: accepted, normative stage 05B contract under [ADR-012](adr/012-canonical-planning-ontology.md).
This evolves the pre-release planning ontology, without changing storage authority,
frozen v1 history, capability enforcement or execution fencing guarantees.

## Six distinct planning artifacts

```text
Intent
  -> Product Definition
  -> Requirements
  -> System Architecture
  -> Program Design
  -> Vertical Slice Plan
  -> Task Plan / Task DAG
  -> Execution -> Verification -> Completion
```

| Artifact | Question and responsibility | Content schema |
| --- | --- | --- |
| Product Definition (`product`) | WHY: user/problem/opportunity and desired outcomes, not a proposed implementation | `aira.dev/product/v1` |
| Requirements (`requirements`) | WHAT observable behavior and constraints the system must satisfy | `aira.dev/requirements/v2` |
| System Architecture (`architecture`) | HOW the change fits system boundaries, ownership, interfaces, persistence, external systems and topology | `aira.dev/architecture/v1` |
| Program Design (`program-design`) | WHAT intended files, symbols, signatures, call/error paths, transformations and tests implement that architecture | `aira.dev/program-design/v1` |
| Vertical Slice Plan (`slice-plan`) | IN WHAT end-to-end reviewable/verifiable increments behavior becomes real | `aira.dev/slice-plan/v1` |
| Task Plan (`tasks`) | WHAT bounded implementation operations belong to each increment | `aira.dev/tasks/v2` |

These are strict structured documents, not six sections inside Markdown. Each contains
Spec and immutable revision identity; its `artifact-revision/v2` envelope binds the
exact canonical content hash/size/media type, creator and operation, immutable lineage
and optional exact authoring profile snapshot. Applicability, analysis, human approval
and staleness are independent records over those exact references. A generated artifact
requires behavioral attribution; an explicitly unassisted human author need not invent
one. Intent and Verification Plan remain separate supporting artifacts, not substitutes
for any of the six planning layers.

### Product versus Requirements

Product contains a nonblank problem and current pain/opportunity, structured users,
actors/stakeholders and needs, desired outcomes, success criteria, non-goals,
assumptions, constraints, risks/mitigations, unresolved questions and optional external
business constraints. At least one meaningful outcome, success criterion and stakeholder
is required structurally. Success criteria may link Product outcomes and record a
measurement. Empty or unmeasurable prose quality beyond structural checks is analyzed,
not declared automatically correct by a decoder.

Product outcomes have `O1`, `O2`, etc. Success criteria have `SC1`, `SC2`, etc. Requirements
retain `R1` and owned `R1.AC1` identities, priorities, EARS/freeform AC semantics,
dependencies and measurable targets. Explicit `product_outcomes` and `success_criteria`
arrays establish Product mappings. MUST functional requirements require at least one
valid mapping, including an indirect outcome mapping through a success criterion.
Technical constraints can leave both arrays empty. Product risks and business concerns
are not forced into fake system Requirements.

### System Architecture versus Program Design

Architecture decisions use `A1`, `A2`, etc., Requirement/AC references, rationale,
alternatives and risks. Optional structured sections represent system context;
components, boundaries, responsibilities and ownership; directed dependencies;
API/event/message interfaces; data ownership and persistence; storage implications;
data flow and interactions; external systems and trust; concurrency, failure/security
boundaries; compatibility/migration; observability; performance/scalability; runtime
and deployment impact; system rollback; alternatives, risks and non-goals. Irrelevant
sections can be absent. Dependency endpoints must name declared components.

Program Design decisions use `PD1`, `PD2`, etc. and can reference A/R/AC identities,
planned files and proposed symbols. The document explicitly represents files to create,
modify or remove, responsibilities/owners, types/interfaces/classes/functions/methods,
public signatures, inputs/outputs/errors, ordered call paths, state/data transformations,
persistence operations, invariant preservation, error creation/translation/propagation,
concurrency, unit/integration/contract/regression/failure/concurrency test designs, and
patterns/dependency/compatibility constraints. Symbols are design intent, not parsed ASTs.
Files and proposed symbols are named and validated locally, never located by array index.

Each PD decision records uncertainty status (`decided`, `uncertain`, or
`human-clarification-required`), confidence, risk, open alternatives and questions.
Clarification-required decisions must carry a question. Architecture contradictions are
first-class relationship findings; Program Design cannot silently revise Architecture.
Semantic uncertainty is represented, not treated as proof that design is complete.

### Vertical Slice versus Task

A Slice is an end-to-end observable increment, not a task group, horizontal layer or
milestone label. Stable `S1`, `S2`, etc. identify title, intent/outcome, Product outcomes,
R/AC/A/PD references, predecessor Slices, contained Tasks, required verifiers,
completion predicates, demonstration/review criteria, risks, optional human checkpoint
policy/verifier, and optional rollout/migration concern. Each predicate has an explicit
verifier. Checkpoints bind a human-review verifier and its exact policy.

Implementation Slices require tasks, outcome, demonstration, completion predicates and
verifiers. Taskless slices require explicit `non-implementation` kind, justification and
policy reference; they are not a miscellaneous foundation-work escape hatch. Current
evidence remains task/attempt-bound, so a taskless review can only use a legitimate
existing verification observation, never a fabricated standalone worker success.

Vertical slicing provides early end-to-end feedback, bounded implementation scope,
meaningful review checkpoints, reduced long-horizon agent drift, and the opportunity to
re-steer before a huge implementation accumulates. Structural checks cannot prove all
semantic qualities of a Slice. Agent/human analysis of coherent end-to-end value remains
necessary; a nonblank outcome is not a deterministic proof of good slicing.

## Identity and graph semantics

O/SC/A/PD/S identities join the existing R/AC/T/V and finding registry. IDs survive edits
and reorder; removals leave tombstones and retired IDs cannot be reused. Graph ordering
uses identities and explicit edges. Sorting by codepoint is only a deterministic
presentation tie-breaker. It does not imply chronological or dependency order.

Slice DAG validation rejects duplicate IDs, unknown/self dependencies and cycles. Cycle
diagnostics are sorted strongly connected components, stable under reordering. Task DAG
validation is separate. Each Task has a mandatory `slice` and each Slice lists its tasks;
reciprocal membership must agree and every Task must have exactly one owner. A Task in
S2 may depend on a Task in S1 only if S1 is a direct/transitive Slice predecessor of S2.
Same-Slice Task edges are legal. Backward edges and orphan/multiply-owned Tasks fail.

`slice-state/v1` separates pending, ready, running, verifying, completed, failed, blocked,
interrupted, skipped, cancelled and unknown execution observations from definitions.
States bind exact Slice Plan, run and run generation, and selected verifier/evidence IDs.
Ready requires completed predecessors, current/applicable planning, applicable approvals
and no unwaived blocking findings. Failed/interrupted/skipped predecessors do not count.
Task readiness also requires an explicitly active runnable owning Slice and completed
Task prerequisites. A verifying Slice cannot start more Tasks. No scheduler selects or
activates Slices here; initial runtime may later allow only one active Slice.

Slice completion requires completed required Task states with current task completion
policies, passing current applicable selected Slice verification, every predicate and
configured human checkpoint. Spec completion independently rechecks all required Slices
and Tasks, the six approved applicable planning artifacts and analyses, no blocking
findings, behavioral attribution, expanded traceability, current workspace/evidence,
no unsafe active execution, and final consistency review policy. Worker completion alone
cannot complete either a Task or Slice.

Stable blockers include `product-missing`, `architecture-stale`, `program-design-blocked`,
`slice-plan-stale`, `slice-not-completed`, `slice-verification-missing`,
`slice-checkpoint-policy-mismatch`, `task-slice-missing`, `task-multiple-slices`,
`cross-slice-dependency-order`, `owning-slice-not-runnable`, and Product coverage/evidence
gaps. Existing exact approval/evidence/completion blocker codes remain available.

## Analysis and exact decisions

One `analysis/v2` infrastructure retains severity, disposition, human dismissal,
resolution and policy-authorized exact waiver rules. Findings have exact artifact
subjects and typed targets: artifact, O, SC, R, AC, A, PD, S, T or a cross-artifact
relationship. Unknown target identities cannot bind merely because an old ID occurs in
some unrelated document. All six phases have current applicable analysis obligations.

Product categories cover unclear problem/user/outcome, solution-as-problem, missing or
non-measurable success, contradictory goals, missing non-goals, scope explosion,
stakeholder ambiguity, assumptions, risks and unnecessary feature scope. Architecture
categories cover uncovered requirements, boundaries, ownership, dependencies, data/trust,
concurrency, compatibility/migration, operations, performance, topology, complexity and
repository contradictions. Program Design categories cover A contradictions, ownership,
layering/coupling, symbols, call/error/state paths, concurrency, testability/tests,
oversized/duplicate responsibilities, unsafe dependencies and unresolved uncertainty.
Slice categories cover horizontal layering, outcome/verifiability, size/triviality,
coverage, coupling/cycles/sequencing, shared state, incoherence, unnecessary tasks and
unrelated goals. No LLM analysis is implemented.

Per-artifact approvals bind exact revision/hash/provenance subjects and observed/resulting
Spec generations, with explicit carry-forward. Integrated quick approval binds exactly
all six planning subjects, never an opaque bundle or title. A changed Slice Plan cannot
retain its old approval even if its visible title is unchanged.

## Authoring modes and causal lineage

Requirements-first: Product -> Requirements -> Architecture -> Program Design -> Slices
-> Tasks. Architecture-first: Product -> Architecture proposal -> Requirements ->
Architecture validation/revision -> Program Design -> Slices -> Tasks. Quick authors and
analyzes the complete canonical set with fewer human interruptions and final integrated
approval; it may use either order. Profiles govern differentiated behavior/presentation,
not permission to skip artifacts, consistency, approvals or completion invariants.

`derived_from` remains immutable acyclic provenance. `validated_against` is separate
exact analysis-backed applicability. Consistent Architecture revalidation does not
manufacture duplicate content or rewrite its authoring snapshot. Relevant upstream
changes stale downstream applicability transitively, never positional replay. A Task
revision cannot stale upstream planning. Architecture-first causal origin exemptions
continue to prevent new Requirements invalidating themselves through reverse validation.

Optional `derived_from.scope` pins stable semantic IDs and hashes. Pure evaluators accept
explicit measured entity observations; storage computes them from exact typed canonical
content using `planningEntities`. Product entity hash subjects include shared Product
context; A subjects include architectural sections; PD subjects include relevant file/
symbol plans and shared program context. Unrelated O/A/PD/S changes can preserve scoped
consumers, while relevant or shared-context changes cannot. Missing observations fail
closed. Unscoped inputs remain conservatively artifact-wide. Approvals still bind full
artifact hashes. Scope is declared dependency intent, not proof that an author omitted
no semantic influence. Evidence remains conservative exact-workspace applicability.

## Complete conceptual trace and queries

```text
O1:  Users retain authenticated continuity safely
 -> SC1: Valid refresh does not require logging in again
 -> R1:  Rotate a valid refresh token
 -> R1.AC1: A valid refresh returns new tokens and retires the prior token
 -> A1:  Session persistence owns atomic token replacement
 -> PD1: TokenService.rotate calls SessionRepository.replaceRefreshToken
 -> S1:  Real end-to-end happy-path rotation
 -> T1:  Implement the service/repository rotation operation
 -> V1:  Refresh contract verifier
 -> Evidence: exact passing observation with approved inputs, attempt and workspace
```

`buildTraceability` returns revision/hash-bound edges, Requirement/AC coverage, Product
outcome/success coverage and current evidence applicability. `traceReachable` answers
structured graph questions and `firstObservableSlices` returns a partial-order frontier,
not an arbitrary lexical first. Reports identify missing Product mappings, requirements
without Slices, A decisions without PD implementation, PD decisions not exercised by
Tasks, and Product success criteria without current passing evidence. MUST R/AC coverage
remains mandatory; Product and extra planning coverage follow explicit completion policy.
New structural Product/R/A/PD/S coverage waivers validate the corresponding stable subject
identity and exact artifact/policy/generation bindings. Product evidence obligations cannot
be waived into fabricated proof; independently required verification still must pass.

## Development-state incompatibility

New schemas: `product/v1`, `architecture/v1`, `program-design/v1`, `slice-plan/v1`,
`slice-state/v1` under `aira.dev/`.

The following existing identifiers advance from `/v1` to `/v2`, retaining the old
identifiers' historical meaning rather than decoding them as the new contract:

- `spec`, `identity-registry`, `spec-completion-policy`, `spec-decision-policy`;
- `requirements`, `artifact-revision`, `analysis`, `lineage-validation`, `artifact-invalidation`;
- `tasks`, `task-definition`, `approved-spec-snapshot`;
- `spec-approval`, `approval-applicability`, `human-waiver`, `revision-request`;
- `execution-run`, `attempt`, `task-claim`, `context-declaration`, `context-snapshot`;
- `verifier`, `verification-plan`, `evidence`;
- `builtin-bundle`, `spec-kind-profile`, `mode-profile`, `behavioral-resolution-request`,
  `behavioral-resolution`, `behavioral-profile-snapshot`.

`design/v1`, generic D identities, `design-first`, `design-generation` and
`design-analysis` are retired from canonical use, with no automatic conversion.
Unchanged schemas including Intent, raw behavioral asset identities, workspace contracts,
file-store FORMAT, blob hashing and transaction envelopes retain their versions.
Historical published asset pins cannot be edited or relabeled; new behavior needs new
asset identities/revisions. Development stores containing retired schemas fail closed.
Frozen legacy v1 fixture bytes and migration rules remain untouched.

Project Steering, Context filesystem resolution, workspace/runtime providers, workers,
scheduler claims/execution, verifier runners, sandboxing, frontend UX, materialized
Markdown and production prompt content are explicitly outside stage 05B. Future exact
Steering snapshots belong in Context, not a new section masquerading as these artifacts.
