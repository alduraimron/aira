# SDD v2 pure domain contract

Implementation stage 3, ADR-011 behavioral assets, stage-4/5 persistence, and the
stage-05B [canonical planning model](planning-model.md) under
[ADR-012](adr/012-canonical-planning-ontology.md), and the stage-05C-1 pure
[Project Steering foundation](steering-contract.md) under
[ADR-013](adr/013-project-steering.md). ADR-012 explicitly retires the
pre-release generic Design ontology and versions affected contracts. The
[file storage foundation](storage-contract.md) retains its publication protocol.
References below to deferred adapters do not imply storage is unimplemented.

This document maps the domain implementation to the accepted
[architecture](architecture.md), [ADRs](architecture.md#adr-index), and
[invariants](invariants.md). It does not replace or relax those decisions.

## Boundary and validation

The v2-only modules evolve the unreleased domain; generic Design is removed. Existing runtime barrels, CLI/Core/Pi code, recipe
execution, v1 persistence, approvals, and frozen fixtures are unchanged. New domain
modules import only TypeScript, Zod, and other pure v2 modules. No store, scheduler,
worker, filesystem resolver, fingerprint capture, policy interceptor, or sandbox is
implemented. `tests/domain-v2/boundaries.test.ts` checks the transitive import closure
and that legacy modules do not activate this domain.

Persisted contracts use strict Zod objects, with no coercion, default injection,
trimming, or unknown-key stripping. `.safeParse()` exposes structured Zod issues;
relationship validators return deterministic `DomainIssue` records. Applications must
validate both schema and cross-record relationships before publication. In particular,
`tasksSchema` validates intrinsic DAG shape; `validateTaskGraph` additionally validates
its external reference catalog. `tasksDocumentSchema` is only the shape decoder used
to produce semantic-ID diagnostics, not a sufficient publication validator.

Historical artifacts, canonical definitions, analyses, approvals, waivers, revisions,
attempts, evidence, policies, and fingerprints have readonly exported domain types
where applicable. Schema parsing produces detached data, not filesystem immutability.
`validateImmutableRevision` rejects changing an existing revision identity. A later
store must enforce immutable identity-to-bytes mappings, verify content hashes, and
publish authoritative applicability changes transactionally. This stage does not
pretend that a TypeScript type implements those storage guarantees.

## Version and identity conventions

The domain is named **SDD v2**, independently of individual contract versions.
The convention is `aira.dev/<contract>/vN`. New contracts start at v1; affected
pre-release contracts advance to v2 under the [version inventory](planning-model.md#development-state-incompatibility).
Versions are literal discriminants, never
inferred from optional fields. Unknown versions fail closed. Nested value objects are
versioned by their enclosing contract; independently revisioned/persistable documents
have explicit schemas. This is unrelated to legacy RunState's numeric `version: 1`.

Contract identifiers introduced:

| Area | Contract names under `aira.dev/` (versions in the linked inventory; unaffected contracts remain v1) |
| --- | --- |
| Spec | `spec`, `intent`, `identity-registry`, `spec-decision-policy`, `spec-completion-policy` |
| Artifacts | `artifact-revision`, `product`, `requirements`, `architecture`, `program-design`, `slice-plan`, `analysis`, `lineage-validation`, `artifact-invalidation` |
| Slices and Tasks | `slice-state`, `tasks`, `task-definition`, `task-state` |
| Human decisions | `spec-approval`, `approval-applicability`, `human-waiver`, `waiver-applicability`, `revision-request` |
| Execution | `approved-spec-snapshot`, `execution-profile`, `execution-run`, `attempt`, `task-claim`, `transaction-preconditions`, `retry-policy`, `reconciliation` |
| Context | `context-declaration`, `context-snapshot` |
| Capabilities | `capability-policy`, `effective-capability-policy`, `capability-escalation` |
| Workspace | `workspace-handle`, `workspace-fingerprint`, `workspace-observation`, `execution-backend` |
| Verification | `verification-plan`, `verifier`, `evidence`, `evidence-applicability/exact-workspace` |
| Behavioral assets | `behavioral-asset`, `builtin-bundle`, `spec-kind-profile`, `mode-profile`, `behavioral-resolution-request`, `behavioral-resolution`, `behavioral-profile-snapshot` |
| Project Steering | `steering-resource`; target later slices add `steering-snapshot` while embedded rules/inclusion/scope/bindings remain versioned by the resource envelope |

`aira.dev/asset-bytes/raw/v1` separately identifies unnormalized effective asset bytes;
self-identity envelopes are outside their content-hash subjects. `aira.dev/glob/v1`
separately identifies the deterministic declaration grammar.
Extension maps exist only for explicit custom verifier configuration and custom
workspace/provider state. They are JSON data, not executable extensions or implicit
permission grants.

Human-facing IDs use positive decimal suffixes without leading zeroes:
`O1`, `SC1`, `R1`, `R1.AC1`, `A1`, `PD1`, `S1`, `T1`, `V1`. An AC's requirement prefix must match its owner.
Except for the behavioral asset identities below, other IDs use `<prefix>_<token>`, where the token matches
`[a-z0-9][a-z0-9_-]{0,63}`. Prefixes are `spec`, `rev`, `approval`, `revision`,
`finding`, `run`, `attempt`, `evidence`, `workspace`, `policy`, `snapshot`,
`context`, `operation`, `claim`, `waiver`, and `profile`. Each has its own Zod brand.

Identity is Spec-scoped where appropriate, never an array index. The embedded identity
registry retains introduced/retired revision references. `validateIdentityEvolution`
protects history; `validateIdentityChange` also requires tombstones for removal and
rejects reintroducing retired obligations. Editing an obligation preserves its ID;
replacing it with an unrelated obligation requires a new ID. No random ID generator or
positional replay is provided.

Integrity identities are lowercase `sha256:<64 hex digits>`. UTC timestamps are
validated against actual calendar dates without normalization. CommitSequence,
SpecGeneration, RunGeneration, and FenceEpoch are separately branded canonical decimal
**u64 strings**. Checked successor operations reject overflow. Byte sizes, capacities,
and scheduling priorities are nonnegative safe integers, with positive bounds where
required. No counter uses imprecise JSON floating-point storage.

## Project Steering pure foundation

`src/steering/` is a pure project-level domain separate from Spec artifacts,
Context delivery, behavioral assets, and capability execution. Stage 05C-1 supplies
logical resource/rule/revision/snapshot identities, the closed standard/custom kinds,
immutable exact body references, provenance and adoption links, structured rule
metadata, strict authority, typed Policy/Verifier/check/extension bindings, deterministic
inclusion/scope declarations, hierarchy/override declarations, and stable structural
validation issues.

Only `aira.dev/steering-resource/v1` is independently persistable in the foundation;
`aira.dev/steering-bytes/raw/v1` identifies exact unnormalized body bytes. Nested value
objects do not receive fake standalone schema IDs. The target snapshot and resolver
identities are reserved by the master contract, but no resolver, snapshot construction,
filesystem discovery, storage publication, Context integration, worker integration, or
runtime enforcement is implemented in 05C-1. See the master contract for exact later
composition, conflict, snapshot, staleness, adapter, security and delivery semantics.

## Behavioral assets, profiles and exact attribution

[ADR-011](adr/011-versioned-behavioral-assets.md) closes the behavioral-input identity
gap before storage is frozen. `src/builtins/` is pure product-asset domain code, not
Spec artifact content, a filesystem registry or a built-in Markdown library.

`BuiltinAssetId` identifies `builtin.<dotted-name>` or
`project.<owner>.<dotted-name>` independently of paths. Separately branded asset/bundle
revision IDs are canonical positive decimal u64 strings. `BuiltinBundleId` uses
`bundle.aira.<dotted-name>`. Every revision has the existing SHA-256 hash, immutable
provenance (`aira-builtin` or `project`), structured compatibility, publication metadata
and optional exact earlier predecessor. Unknown schema/kind/role/source versions and
mutable revision aliases are rejected.

The first kinds are prompt-profile, analysis-profile, spec-kind-profile, mode-profile,
skill, context-profile, capability-policy-profile, verification-profile, execution-profile
and execution-recipe. The common reference union reuses `ProfileReference` for existing
analysis/context/execution/recipe/verification profiles and `PolicyReference` for
capability policy. Verifiers retain their existing identity through plans/evidence;
there is no competing built-in policy/verifier identity model.

Role/pin schemas distinguish required behavior from its exact implementation. The closed
role vocabulary covers clarification, the twelve authoring generation/analysis activities,
implementation, repair, implementation/verification/final-spec review, context, capability,
verification and execution profiles, execution recipe, kind/mode profiles and Host skill.
Pins contain exact asset revision/hash/provenance and optional exact bundle membership,
not full asset bodies. Project IDs and owners must agree and cannot claim Aira bundles.

Kind profiles carry the existing feature/bugfix/refactor/migration/custom kind plus
nonempty exact role selections and required roles. Mode profiles configure authoring
order and analysis/approval/review presentation but cannot relax lifecycle semantics.
Quick retains canonical analyses and integrated human approval; it can use either
canonical authoring order. Kind/profile-content differentiation is a release quality
obligation, not something a schema can prove by checking labels alone.

Bundle manifests contain exact shipped asset references, distribution metadata,
compatibility, role defaults and typed kind/mode defaults. Schemas reject duplicate
revision identities and inconsistent selections. `validateBuiltinBundleContents` checks
all published members, nested selection closure and the actual kind/mode configurations;
ordinary resolution can use a catalog containing only its needed exact revisions.
The pure catalog represents supplied
verified-content observations, not storage. Future authenticated decoders must establish
that the measured bytes and decoded configuration/typed references agree. An asserted
hash/provenance field alone is not proof. The revision/history/bundle immutability
validators protect the entire published envelope, not only its content hash.

Resolution returns ordered, inspectable candidates and effective pins. Ordinary precedence
is task (execution-related slots only), Spec, kind, mode, bundle. Kind specializes mode;
Spec-level selectors choose exact kind/mode profiles. Capability decisions retain **all**
restriction layers and bridge into the existing policy compiler rather than replace
parents. Every resolved exact reference must be available, authentic and compatible;
there is no search for latest or fallback on errors. Compatibility checks domain/schema
membership, closed runtime capabilities, actual backend requirements/identity and
versioned asset interfaces without a dependency solver.

The Spec has mandatory explicit `behavioral_selections` and append-only
`behavioral_profiles` output bindings. An unassisted human-authored Spec can explicitly
start with empty lists. A generated artifact must reference an immutable profile snapshot;
absence is never a request to load hidden defaults. Snapshots record phase, observed Spec
generation, exact request/decisions, identity/hash and creation provenance. Each of the
twelve authoring phases can retain a different snapshot. Schema and cross-record validation
bind analysis phases, output revision/hash, envelope references and snapshot hashes;
snapshot validation replays only its recorded exact inputs.

Adoption/addition is a semantic generation mutation, checked by
`validateSpecBehavioralEvolution`. Historical bindings are not removed or rewritten.
Architecture-first revalidation may use a new analysis snapshot without rewriting the unchanged
architecture's original provenance or fabricating a content approval. Existing invalidation
and fencing obligations remain authoritative for relevant selection changes.

Approved Spec/run snapshots have mandatory authoring bindings and exact execution pins.
Attempts have a required purpose and used pins, including the actual purpose, context,
capability and execution profile. Context snapshots bind their resolver-policy profile
pin. Evidence binds exact verification/policy/review selections and cannot attribute pins
absent from its attempt or omit capability restriction layers. Task definitions have
explicit allowed `behavioral_selections`; a task override cannot be inferred from a new
global default. `validateAttemptBehavior` checks task/context references, parent layers,
exact catalog availability and compatibility against the attempt's actual backend.
Completion additionally requires supplied behavioral catalog/environment/snapshot/context
observations and invokes closed binding/availability checks. Evidence and approved-snapshot
comparisons include behavioral provenance. Historical records remain attributable when
new defaults are published; future durable use of an unavailable pin fails closed.

Raw content hashes exclude a record's own identity envelope to avoid self-hash cycles.
Structured profile bodies include their versioned configuration and selected references;
`asset` is attached outside those bytes. Snapshot/bundle bodies similarly exclude their
own `identity`. Byte capture, parsing/authentication and immutable durable publication
remain adapter/store obligations. No prompt/skill Markdown or default template is added.
The [release-completeness checklist](release-completeness.md) requires production built-ins,
independent quality tests, user conceptual/reference documentation and end-to-end examples.

## Spec, lifecycle, and canonical content

One Spec schema supports feature, bugfix, refactor, migration, and custom kinds, and
requirements-first, architecture-first, and quick modes. `authoring_order` distinguishes
ordering from human gate placement; quick can use either authoring order. The Spec
selects exact current/proposed/superseded artifacts, current analyses, active lineage
records, approval/waiver applicability, revision request identities, policies, identity
history, generation, metadata, and an optional exact run binding.

Lifecycle states:

- `draft`
- `drafting-product`, `analyzing-product`, `waiting-product-approval`, `product-approved`
- `drafting-program-design`, `analyzing-program-design`, `waiting-program-design-approval`, `program-design-approved`
- `drafting-slice-plan`, `analyzing-slice-plan`, `waiting-slice-plan-approval`, `slice-plan-approved`
- `drafting-requirements`, `analyzing-requirements`, `waiting-requirements-approval`, `requirements-approved`
- `drafting-architecture`, `analyzing-architecture`, `waiting-architecture-approval`, `architecture-approved`, `validating-architecture`
- `drafting-tasks`, `analyzing-tasks`, `waiting-tasks-approval`, `waiting-integrated-approval`
- `ready`, `implementing`, `verifying`, `completed`, `cancelled`, `blocked`, `interrupted`

`checkLifecycleTransition` is a **structural** transition check, not an authorizer.
`evaluateLifecycleTransition` checks authoring/approval gates; completion uses
`evaluateCompletionTransition` and the full completion predicate. Blocked/interrupted
states record their suspended state and reason, and cannot resume at a later gate.
`evaluateTaskArtifactPromotion` checks consistency and mode-specific gates for a
candidate current task artifact. These functions propose decisions without changing
Spec generation or publishing artifacts.

Product, Architecture, Program Design and Slice contracts and their deterministic
validators are specified in [planning-model.md](planning-model.md). Product supports
structured stakeholders, outcomes and success criteria; Program Design records code
intent and uncertainty; Slices are end-to-end increments with a separate DAG.
`validateProduct`, `validateRequirementsProduct`, `validateArchitecture`,
`validateProgramDesign`, `validateSliceDAG`, `validateSliceReferences`,
`validateTaskSliceConsistency`, `sliceReadiness` and `evaluateSliceCompletion` are pure.

Requirements additionally contain explicit Product Outcome and Success Criterion
references. MUST functional behavior needs a mapping; technical constraints do not
need fabricated Product intent. Requirements contain typed priority/statement/rationale/assumptions/dependencies,
optional measurable targets, and structured acceptance criteria. EARS forms include
ubiquitous, event-driven, state-driven, unwanted-behavior, optional-feature, and complex;
freeform criteria retain both expected behavior and fallback text. Markdown is not
parsed for canonical semantics.

System Architecture decisions have stable IDs, requirement/AC mappings, rationale, alternatives,
and risks. Optional structured sections cover architecture context, components,
interfaces, data flow, failure behavior, concurrency, security, compatibility,
migration, observability, performance, deployment, rollback, and exclusions.
Concrete test and symbol/call-path design belongs to the distinct Program Design.

Findings bind analyzed revisions, severity, category, and disposition. Dismissal needs
human rationale. Resolution records an exact artifact or human answer. Changed
findings/dispositions belong to new immutable analysis results, not rewritten history.
Unresolved blockers require an exact, policy-authorized human waiver; warnings alone
are not blockers. All six canonical authoring analyses remain required in quick mode.

## Provenance, staleness, and decisions

An artifact revision contains immutable identity, kind, content hash/size/media type,
creation provenance, and typed `derived_from`, `generated_from_intent`, and `supersedes`
edges. It does not contain a mutable current content field. Canonical content documents
identify their revision; task/verifier definition identities separately identify their
revision and body hash. Hashes are over externally encoded canonical bodies/blobs,
not self-hashes over an envelope containing its own hash. Byte encoding/hash capture
belongs to the later store/adapter contract, not `canonical()` (a comparison helper).

`validated_against` is an exact-bound, analysis-backed applicability record, never
retroactive derivation. Architecture-first Architecture can be approved from Product, inform
requirements, and then be validated against those requirements without a new architecture
revision or redundant content approval.

`currentLineageValidity` checks closed reference integrity and deterministic provenance
cycle components. `deriveStaleness` uses exact current input identities, current
revalidation records, explicit invalidations, and a monotone transitive closure.
Same-kind predecessor provenance is historical: a new revision does not demand its
predecessor remain current. Revalidation can replace an outdated cross-kind applicability
input without changing immutable provenance. Optional stable-entity hash scopes preserve
fine-grained applicability only with exact measured observations, as specified in the
planning model. Missing scope observations fail closed; unscoped lineage remains coarse.

Invalidation is causal. A newly current input is not invalidated by its own invalidation
wave returning through a reverse validation relationship. For example, new requirements
informed by unchanged architecture remain reviewable while that architecture awaits consistency
validation against them. Independent invalidation causes still invalidate those
requirements. This preserves ADR-004's approval-then-revalidation ordering rather than
creating a circular applicability prerequisite. Tasks consuming stale architecture remain
stale transitively. `downstreamAffectedArtifacts` is the conservative impact set;
`artifactApplicability` is the authoritative pure current-use predicate.

Approval records retain the human actor, channel, operation, observed generation,
resulting committed generation, exact revision/hash subjects, decision, time, and
comment. An artifact subject's `lineage_hash` identifies **immutable authoring
provenance**, not later consistency-analysis results. Current consistency/staleness is
checked independently. Thus unchanged architecture may explicitly carry its original content
approval forward after revalidation, without rewriting what the human approved.

Current approval-applicability records bind a resulting Spec generation and exact
subject. Later carry-forward is explicit and checked; revocation/supersession never
changes historical approvals. Run-only bookkeeping does not invalidate review. Quick
approval is one human operation over exactly Product/Requirements/Architecture/Program Design/Slice Plan/Tasks, with six
individual applicability records. Partial sets, changed hashes, missing carry-forward,
and stale subjects cannot authorize execution.

Waivers similarly separate immutable human decisions from current applicability.
Scope IDs, exact subjects, current policy identity, permitted obligation codes,
provenance, rationale, generation, and revocation are checked. A structural coverage
waiver never fabricates passing evidence for an independently configured verifier.
Human actor schemas reject worker/model/system actors. Frontends still must establish
actual explicit human authorization; a provenance schema is not authentication.

Revision requests retain exact feedback bytes as a string, exact prior revision/hash,
human provenance, operation, time, and pending/resolved/cancelled/superseded state.
Resolution binds the resulting revision/hash, optional attempt, operation, and time.
The resulting revision must supersede the correct predecessor. No workflow step index
or positional replay is involved.

## Tasks, execution, and recovery

Every executable Task has exactly one Slice owner, validated against reciprocal Slice
membership. Cross-Slice Task dependencies must agree with the separate Slice DAG. Slice
state is embedded in the run independently of Task state and binds an exact Slice Plan.
A Task is runnable only inside an explicitly active runnable Slice with completed
predecessor Slices, in addition to the existing gates below.

A task definition includes identity/revision/hash, kind, description/outcome, requiredness,
requirement/AC/decision references, prerequisite task IDs, completion conditions,
verifiers, context declarations/references, capability and execution profile references,
workspace/backend requirements, priority, resource labels, and optional cost metadata.
Verification conditions can use command, static, file/repository, human, or permitted
agent review verifiers; artifact-publication conditions are also explicit. Empty
completion policies are rejected.

DAG validation rejects duplicate identities, self/unknown prerequisites, cycles, and
unknown or malformed external references. Cycle reports are sorted strongly connected
components, not traversal-dependent first paths. A ready task requires current approved
applicable artifacts, valid definitions, no unwaived blocker, satisfied policy
preconditions, and every predecessor in domain state `completed`. Failed, interrupted,
unknown, skipped, or successful-but-unverified predecessors do not qualify.

Ready sets are ordered by descending explicit priority, then task-ID codepoint order.
This order is a tie-breaker only, never a dependency. Results contain ready, blocked,
terminal, and active identity sets. They do not reserve capacity or claim ownership.

Definitions and execution states are separate. Task states include pending, ready,
claimed, running, verifying, completed, failed, blocked, interrupted, skipped, cancelled,
and unknown. Run schemas support arbitrary positive `max_parallel`, exact approved
snapshots, task sets, immutable attempt references, claims, current evidence selections,
and fencing authority. Initial scheduling policy is still `max_parallel = 1`; this
stage implements no scheduler. Transaction preconditions include operation identity,
expected commit sequence/hash, separately scoped Spec/run generations, and optional fence.

Attempts bind operation, task definition, run generation, approved snapshot, fence,
context snapshot references, capability/execution policy references, workspace,
backend, recovery declarations, interval, outputs, and explicit outcome. Outcomes
include succeeded, failed, interrupted, cancelled, timed_out, and unknown.

Automatic retry is forbidden without current authority, explicit policy/budget, and
proven recovery declarations. All declarations' safeguards apply. Unknown replay-safe
work may retry by policy; idempotent work also needs the stable operation identity;
reconcilable work needs an exact, evidence-bearing safe reconciliation; non-replayable
work requires human intervention absent an explicit safe reconciliation mechanism.
Interruption/cancellation/timeout never proves absence of effects. There is no
exactly-once claim, metadata CAS implementation, or retry execution here.

## Context, capabilities, and workspace

Context declarations select exact paths, trees, or deterministic globs, with requiredness,
phases/task selection, size limits, inclusion mode, and classification. The glob grammar
is case-sensitive, slash-separated, and includes dotfiles; `*`/`?` match within a segment,
`**` matches zero or more complete segments. Traversal, absolute paths, backslashes,
brace/class expansion, and ambiguous `**` fragments are rejected, not normalized.

Snapshots bind workspace fingerprint, resolver version/policy, phase/task, ordered
entries, hashes, sizes, canonical path identity, declaration reasons, classification,
and source revision/hash where relevant. Logical paths use strictly ascending codepoint
order with contiguous snapshot positions and an exact safe total byte count. Summary
entries retain source identity. Declaration validation checks required/optional selection,
limits, inclusion, and classification, without accessing files.

Capability policy composition retains full restriction layers rather than approximating
arbitrary glob intersections. Every layer must allow; any deny/protected-path rule wins;
asks remain human escalation requirements, not grants. Backend hard requirements are
unioned. Tool grants bind actual provider/implementation/version/integrity identity,
not a name alone. Process profiles, arbitrary-shell declarations, destinations, and
environment restrictions are explicit. Compiler output reports backend compatibility
and outstanding enforcement obligations, not a working sandbox or actual I/O permission.

Workspace handles separate provider identity/location/isolation from backend capabilities.
Fingerprints bind schema, algorithm, capture policy, provider/workspace identity, digest,
and Git/custom content components. Git components include repository/base/index/tree,
tracked content/diff, untracked content, and submodule state. Capture policy explicitly
records ignored files, symlinks, submodules, generated files, exclusions, and Aira storage.
Exact comparison includes all components, not just the displayed digest. Stable observation
and coordination-contract records make the completion observation boundary explicit.
Worktree/container labels never imply process, network, environment, or termination guarantees.

## Verification, traceability, and completion

Versioned verification plans identify profiles and exact verifiers, required verifier
sets, and optional final consistency review. Evidence binds exact verifier/profile,
approved Spec snapshot, task definition, attempt, policy/context, before/after fingerprint,
backend, interval, outcome, outputs/hashes, and requirement/AC mappings.

The only current applicability contract is exact-workspace. Both observed fingerprints
must match, the interval must be characterized as stable, and current workspace, snapshot,
verifier/profile, definition, attempt authority, policy, context, backend, and mappings must
match. Human/agent review rules are enforced. Unknown scoped contracts fail closed.
Evidence remains immutable history when failed, stale, interrupted, or superseded.
Current evidence selections are exact task/verifier/evidence bindings in run state;
an unrelated or older passing observation cannot mask a selected failure.

Traceability constructs revision/hash-bound structured edges for Product Outcome ->
Success Criterion -> Requirement -> AC -> Architecture Decision -> Program Design
Decision -> Slice -> Task -> Verifier -> Evidence. Product coverage, first observable
Slice frontiers and missing A/PD/S implementation links are structured reports. Reports expose architecture/task/verifier coverage, required
verifier subsets, applicable evidence, and missing required obligations. Requirement-level
decisions cover their ACs unless narrower AC mappings were declared. MUST coverage is
always enforced; policy can additionally require SHOULD or all priorities. Optional
verifiers remain queryable without pretending they satisfy required verification.

Completion revalidates strict contracts and requires approved applicable artifacts,
required consistent analyses, no unwaived blocker, correct identity history, current
run/snapshot/policy applicability, completed required task policies and prerequisites,
passing selected applicable evidence, traceability, a stable current workspace observation,
no active/unsafe execution, and configured final consistency review. Results contain
stable structured blocker codes, including `artifact-stale`, `artifact-approval-missing`,
`unresolved-blocker`, `task-not-completed`, `required-verification-missing`,
`evidence-workspace-mismatch`, `requirement-verification-missing`, `active-execution`,
and `final-consistency-review-missing`. Schema failures produce `invalid-domain-contract`.

## Test coverage and deferred obligations

`tests/domain-v2/` contains independent pure-domain suites for identities/schema versions,
lifecycle/provenance, findings/approvals/waivers/revisions, DAG/readiness, context/policies,
workspace/evidence/traceability, completion, recovery, and import purity. Tests cite the
Spec, domain, generation, approval, lineage, task, traceability, completion, context,
capability, workspace, execution, evidence, and legacy invariant families.

Storage crash publication (INV-STORE-001/002/003), actual I/O confinement, workspace
capture/coordination, and transactional claim/result publication remain obligations for
later implementation stages, not claims established by these domain tests. No locked
architecture contradiction was discovered. ADR-011 and INV-BUILTIN-001 through
INV-BUILTIN-007 plus INV-DOC-001 now add the missing behavioral-asset/release contract;
none of ADRs 001-010 or their invariants is relaxed. `tests/domain-v2/builtins/` adds
identity/provenance, bundle, resolution, kind/mode, compatibility, snapshot, execution,
capability composition and evidence-attribution coverage. Existing v2 fixtures now
explicitly identify synthetic execution inputs; their assertions are not weakened.
