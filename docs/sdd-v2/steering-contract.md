# Aira SDD v2 Project Steering contract

Status: accepted, normative for all Steering implementation slices. See
[ADR-013](adr/013-project-steering.md) and the
[stable Steering invariants](invariants.md#project-steering-adr-013).

This document defines the complete v2 Project Steering architecture. The target
contract is normative even where delivery is split across 05C-1 through 05C-5.
05C-1 implements pure identities, types, schemas, declarations, and structural
validation. 05C-2 adds [pure deterministic composition](steering-resolution-05c2.md)
under the exact v1 resolver policy. 05C-3A adds [immutable snapshots, dependency
bindings, and causal staleness](steering-snapshot-05c3a.md). 05C-3B1 adds the
[authoritative project registry and resource persistence](steering-store-05c3b1.md).
05C-3B2 adds [immutable snapshot persistence and the combined storage audit](steering-store-05c3b2.md).
05C-4A1 adds the read-only [native project source contract, exact-byte parser,
and bounded inspection adapter](steering-native-source-05c4a1.md). 05C-4A2A adds
[explicit native-source adoption](steering-adoption-05c4a2a.md) through human
authorization, exact source/registry freshness, and SteeringStore CAS. 05C-4A2B
adds [safe authoritative native-source materialization](steering-materialization-05c4a2b.md)
without changing authority. Deferred interoperability adapters are not permission
to substitute a weaker architecture.

`MUST`, `MUST NOT`, `REQUIRED`, and `SHOULD` are normative in this document.

## Purpose and position in the system

Project Steering is the persistent project-level knowledge and constraint domain
that governs Spec authoring, review, execution, and verification.

A Spec answers: "What change are we making?"

Steering answers: "What kind of project is this, how is it built, and what rules
must changes respect?"

The relationship is:

```text
Project Steering
  |-- Product Context
  |-- Architecture Constitution
  |-- Technology Constraints
  |-- Repository Structure
  |-- Engineering Standards
  |-- Testing Standards
  |-- Security Standards
  |-- Operational Expectations
  `-- Custom Steering
          |
          v
Steering Resolution
          |
          v
SteeringSnapshot
      |                |
      v                v
Spec SDD          Worker Context
      |                |
      `-------+--------'
              v
Intent -> Product Definition -> Requirements -> System Architecture
       -> Program Design -> Vertical Slice Plan -> Task DAG
       -> Execution -> Verification -> Completion
```

Steering is not Spec-owned. A project can have many Specs governed by the same
Steering revisions, and one Spec can use different immutable Steering snapshots
for different actions. Steering is not a prompt suffix, a behavioral asset, a
capability policy, or the whole Context system.

Definitions:

- A **Steering resource** is a stable logical project knowledge or rule unit.
- A **Steering revision** is one immutable resource envelope and exact body hash.
- A **Steering rule** is structured metadata for one stable declaration in a
  resource body.
- **Steering resolution** is the deterministic pure operation that evaluates
  source eligibility, scope, inclusion, hierarchy, compatibility, overrides,
  conflicts, and enforcement links for a declared action.
- A **SteeringSnapshot** is the immutable exact output of successful resolution.
- A **materialization** is a file or other external representation. It is never
  the logical identity or authority by itself.

## Identity, versions, and exact content

### Logical identities

A Steering identity is scoped by the Aira project/control identity. Within that
control plane, the pure domain uses these logical namespaces:

| Namespace | Meaning | Example |
| --- | --- | --- |
| `steering.*` | canonical native project resource | `steering.architecture` |
| `project.steering.*` | additional native project resource | `project.steering.api-conventions` |
| `template.steering.*` | Aira template source | `template.steering.security` |
| `interop.steering.*` | direct interoperability source | `interop.steering.agents-md` |
| `imported.steering.*` | other imported source | `imported.steering.company-standards` |

Names are lowercase dotted kebab-case segments. They are not filenames, URLs,
array indexes, headings, or repository-relative paths. Moving a materialization
cannot change its `SteeringResourceId`.

`SteeringRevisionId` is a separately branded canonical positive decimal u64
string. The immutable revision key is `(project/control identity,
SteeringResourceId, SteeringRevisionId)`. The exact reference also includes the
lowercase SHA-256 content hash. Mutable values such as `latest`, `current`, a
filename, a branch, or a floating version are invalid.

`SteeringRuleId` uses the logical `rule.<dotted-name>` namespace and remains
stable across edits to the same rule. `SteeringSemanticKey` uses
`topic.<dotted-name>` and names the semantic conflict slot. Neither identity is a
Markdown line number or list position. `SteeringSnapshotId` uses its own
`steering_snapshot_<token>` namespace and is not a Context snapshot ID.

### Persisted schema identities

The current independently persistable Steering revision contract is:

- `aira.dev/steering-resource/v1`
- body byte encoding `aira.dev/steering-bytes/raw/v1`

The complete target additionally reserves:

- `aira.dev/steering-snapshot/v1`
- resolver contract `aira.dev/steering-resolution/v1`

Rules, scopes, inclusion selectors, provenance values, composition declarations,
and enforcement bindings are embedded value objects in
`aira.dev/steering-resource/v1`. They are not independently persisted records in
05C-1, so they do not receive misleading standalone schema identifiers. Their
version is the enclosing resource schema version. If a later design makes one an
independently stored record, that change requires a new explicit persisted
schema and compatibility rules rather than attaching a schema label to a TypeScript
type retroactively.

Schema literals are exact discriminants. Unknown resource, snapshot, resolver,
raw-byte, or extension-contract versions fail closed. No default injection,
coercion, trimming, unknown-key stripping, or version guessing is permitted in
an authenticated decoder.

### Hash subject and bytes

The body is stored outside the pure domain as exact bytes and is referenced with
hash, byte count, and media type. Whitespace, Markdown formatting, code blocks,
examples, and line endings are content. There is no invisible normalization.
The existing BlobStore lowercase SHA-256 semantics are authoritative.

The resource identity envelope is not recursively included in its own body hash.
The envelope's `identity.hash` MUST equal `content.hash`. Structured rule source
references MUST name that same hash. `canonical()` is a comparison helper and
MUST NOT be used as the byte-hash algorithm.

## Resource kinds and the standard project set

A resource purpose is a closed `SteeringResourceKind`, separate from authority:

- `product`
- `architecture`
- `technology`
- `structure`
- `engineering`
- `testing`
- `security`
- `operations`
- `custom`

`custom` requires a validated dotted custom category such as
`api-conventions.rest`, `database`, or `mobile.ios`. Standard kinds are not
unchecked strings. A canonical standard ID such as `steering.security` cannot
claim a different kind.

The intended standard project set is product, architecture, technology,
structure, engineering, testing, security, and operations. This list defines
product coverage, not an instruction for `aira init` to create empty files.
Release templates or generation guidance must be production-grade before they
are created by default. Projects can use multiple resources of one kind and can
add custom resources.

Kind describes purpose. Authority is independent. Product plus descriptive,
architecture plus normative, and security plus enforceable are valid when their
rules and bindings satisfy the authority contract.

## Immutable Steering revision

`SteeringResourceRevision` represents at least:

| Field | Normative meaning |
| --- | --- |
| `schema` | exact persisted schema identity |
| `identity` | logical resource ID, immutable revision ID, exact body hash |
| `kind`, `custom_kind` | closed purpose and validated custom category |
| `layer` | template, project-root, project-scoped, interoperability, or imported source layer |
| `provenance` | exact source class and source/adoption attribution |
| `content` | exact BlobStore hash, byte count, and media type |
| `content_encoding` | exact raw-byte contract |
| `default_authority` | authority for document-level declarations not overridden by a structured rule |
| `default_override_policy` | sealed, narrower-scope, or explicit-replacement behavior for that default |
| `default_enforcement` | typed bindings for the default authority |
| `inclusion` | resource-level inclusion declaration |
| `scope` | maximum applicability scope |
| `rules` | deterministic stable structured rule inventory |
| `composition` | exact parent and explicit override declarations |
| `compatibility` | accepted resolver contract and required versioned contracts |
| `metadata` | title, optional description, and deterministic labels |
| `created` | timestamp, actor, operation, and channel metadata |
| `behavioral_assets` | exact behavioral revisions used to generate or analyze this revision, when applicable |
| `supersedes` | optional exact earlier revision of the same resource |

Every published field is immutable under the same revision key. A change to
body, hash, metadata, provenance, rules, scope, inclusion, authority, bindings,
compatibility, or predecessor publishes a new revision. `supersedes` names one
exact lower revision of the same resource and is revision history, not hierarchy
inheritance. Publication history is linear for an authoritative resource;
ambiguous branches fail publication or selection.

A readonly TypeScript type does not make storage immutable. 05C-3B1 enforces
identity-to-record and hash-to-byte immutability transactionally for resource
revisions and raw bodies.

## Structured rule model

Markdown remains the primary human-readable body, but a resource is not modeled
as one giant anonymous instruction. Each structured `SteeringRule` contains:

- stable `SteeringRuleId`;
- nonblank title;
- explicit authority;
- semantic key, effect, and JSON value;
- override policy;
- active or deprecated status;
- optional narrower scope and inclusion declaration;
- optional rationale;
- zero or more typed enforcement bindings;
- optional exact body-hash plus document, heading, anchor, or line-range source
  location.

A rule's semantic effect is one of:

- `describe`: a fact or context claim;
- `prefer`: a normative preference;
- `require`: a required value or behavior;
- `forbid`: a prohibited value or behavior.

The structured value is authored metadata. Aira does not infer it by pretending
to parse arbitrary English. Authoring formats can combine frontmatter or another
strict structured block with prose. Any normative or enforceable declaration
that must participate in deterministic override, conflict, or enforcement logic
SHOULD have a structured rule entry. Enforceable declarations MUST have one.
Adapters must validate source locations against the exact body hash rather than
trust stale line numbers.

Rules are ordered by `SteeringRuleId` in code-point order. Deprecated rules remain
historical metadata but do not apply to new resolution. Removing and reusing an
ID for unrelated meaning is forbidden. A replacement meaning requires a new ID;
a changed expression of the same rule retains the ID in a new resource revision.

A rule-level scope or inclusion declaration can only narrow the resource-level
declaration. It cannot widen it. 05C-2 proves that relation or fails closed.

## Authority

Authority is a closed enum and is explicit at resource default and rule level.

### Descriptive

Descriptive content records project reality or context. A mismatch is not by
itself a policy breach. Descriptive rules use effect `describe` and MUST NOT have
enforcement bindings.

Examples include the selected database, implementation language, or source tree.
Contradictory relevant descriptive claims are still resolution ambiguity and
must be diagnosed, even though neither creates a violation.

### Normative

Normative content records a rule, expectation, or preferred practice. It uses
`prefer`, `require`, or `forbid`. It is considered during authoring and review,
but English text alone is not a machine security boundary.

A normative rule can cite an advisory verifier, repository check, or extension
for review visibility. Every such binding must be marked `advisory`. A required
machine gate makes the declaration enforceable and therefore requires authority
`enforceable`; it cannot hide under the normative label.

### Enforceable

Enforceable content uses `require` or `forbid` and MUST have at least one
recognized required binding. It cannot use `explicit-replacement` override
policy. Its required mechanism must be available, authentic, compatible, and
usable by the selected backend. Otherwise resolution or preflight fails closed.

Authority labels are claims to validate, not trust sources. The resolver must not
promote descriptive or normative prose to enforceable. A sentence such as "the
AI must comply" is not a recognized binding.

## Enforcement linkage

05C-1 models links but does not execute them. The closed first binding union is:

1. `capability-policy`: an exact existing `PolicyReference`. It is inherently a
   required hard restriction.
2. `verifier`: an exact existing `VerifierReference`, marked `advisory` or
   `required`.
3. `repository-check`: an exact existing verifier plus the closed check purpose
   `architecture-boundary`, `static-analysis`, or `repository-state`, marked
   `advisory` or `required`.
4. `extension`: an exact existing `ProfileReference`, an explicit versioned
   extension contract, and `advisory` or `required` use.

The model deliberately reuses Policy, Verifier, artifact revision, profile, and
content-hash identities. It does not create parallel Steering policy or verifier
ID systems. Path and write restrictions are enforced through capability policy,
not a second path security engine. Architecture/static checks remain verifier
mechanisms. Custom enforcement requires a versioned contract and exact mechanism
profile; an unchecked string or prose promise is invalid.

Duplicate exact bindings are invalid. Reusing one mechanism identity with a
different hash, use, or contract is a structural conflict. Binding arrays have a
canonical order. Later catalog validation must authenticate exact referenced
records and measured bytes. A structurally valid reference is not proof that a
backend actually enforces it.

All applicable capability-policy layers are retained and composed by the
existing deny-wins capability compiler. Steering cannot convert a deny into an
allow, authorize escalation, claim backend confinement, or bypass
INV-CAP-001 through INV-CAP-004.

## Provenance, templates, imports, and behavioral attribution

Provenance is a closed union:

- `project`: native project content with project namespace and authored or
  adopted origin;
- `aira-template`: an Aira-published template source with matching published
  content hash;
- `interoperability`: direct exact source bytes, initially `AGENTS.md`, plus an
  exact adapter profile;
- `imported`: another versioned external source, exact source identity/revision
  and hash, exact importer profile, and explicit exact or transformed status.

Provenance, logical namespace, and layer must agree. Exact interoperability and
exact imports have the same effective/source hash. A transformed import retains
both original source hash and transformed Steering content hash.

An Aira template is not project authority and is not directly selected into a
project SteeringSnapshot. Instantiation or adoption creates a project-namespaced
revision with `project` provenance and an exact `adopted_from` source reference.
Editing adopted bytes keeps project provenance. Project-edited bytes MUST NOT
retain `aira-template` identity or provenance. A future trusted catalog verifies
Aira publication; matching self-declared hashes alone are not authentication.

Project-specific content always retains its actual project provenance. Direct
imports retain import provenance even if they happen to agree with native
content. Copying or transforming imported content into native policy is an
explicit project adoption operation with source linkage, never relabeling in
place.

Behavioral assets answer how Aira generated or analyzed content. A Steering
revision can attribute exact behavioral asset revisions used in its authorship.
Those references do not turn Steering into a behavioral asset or put Steering
body bytes in the behavioral catalog. A generated project revision remains only
a proposal until an authorized project-control publication operation accepts it.

## Inclusion declaration

Inclusion controls whether an otherwise eligible resource or rule is selected
for a resolution request. It is not authority, scope, precedence, or a capability
grant.

Every declaration has:

- `availability`: `required` or `optional`;
- one selector expression.

Atomic selector forms and exact input semantics are:

| Selector | Match rule | Required resolution input | Missing input |
| --- | --- | --- | --- |
| `always` | true | none | impossible |
| `phase` | request phase is in the canonical phase set | phase | invalid request, error |
| `path` | at least one known touched path matches at least one Aira path selector | touched-path observation | unavailable/unknown observation is error; known empty set is false |
| `spec-kind` | request Spec kind and custom kind exactly match an entry | Spec selector when a Spec is in scope | no Spec means false; malformed/incomplete Spec selector is error |
| `task-kind` | request Task kind and custom kind exactly match an entry | Task selector when a Task is in scope | no Task means false; malformed/incomplete Task selector is error |
| `manual` | exact resource/rule was selected by an authorized higher-level operation | manual selection set plus authorization provenance | no selection is false; selection without authority is error |
| `composite` | explicit `and` or `or` over child results | union of child inputs | any child error makes the expression error |

The canonical Steering phases are, in order:

1. `intent`
2. `product`
3. `requirements`
4. `architecture`
5. `program-design`
6. `slice-planning`
7. `task-planning`
8. `implementation`
9. `verification`
10. `review`

Multiple phases use that order. Path, Spec-kind, task-kind, and composite sets use
canonical code-point representation. Atomic list members compose with OR.
Composite nodes express explicit AND or OR. Nested nodes with the same operator
must be flattened, duplicates are invalid, and identity elements such as
`always` inside a composite are rejected. Evaluation visits all children and
collects diagnostics deterministically rather than depending on short-circuit
implementation order.

If a selector matches, `required` means the exact selected revision MUST be
included and unavailable/incompatible content fails resolution. `optional` means
an available match is included, while an unavailable match is omitted with a
stable diagnostic and does not alone fail resolution. `manual` still requires
explicit selection. Once a snapshot pins any entry, missing bytes or records fail
closed regardless of the original availability setting.

## Scope

Scope declares where content is semantically applicable. It is not precedence.
The atomic scope forms are:

- `project-global`;
- `path`, using exact, tree, or `aira.dev/glob/v1` selectors;
- `phase`;
- `spec-kind` with validated custom kind;
- `task-kind` with validated custom kind.

Scopes support canonical recursive AND/OR composition with the same flattening,
uniqueness, and ordering rules as inclusion. A `project-global` identity element
inside a composite is noncanonical. A `project-scoped` resource must have a
narrower-than-global resource scope.

Scope evaluation uses the same request inputs and missing-input rules as the
corresponding inclusion selectors. Resource scope is the maximum. Rule scope,
rule inclusion, and resource inclusion are intersected. Inclusion cannot widen
scope. Scope specificity does not silently establish precedence.

No directory traversal, filesystem matching, canonical path capture, or
WorkspaceProvider is implemented by 05C-1. The reused Aira path grammar is
portable and workspace-relative. 05C-4 must produce canonical logical touched
paths safely before 05C-2 selection logic consumes them.

## Project hierarchy and composition

The target source flow is:

```text
Aira template sources
        |
        | explicit project instantiation/adoption only
        v
Native project-root Steering
        |
        | exact declared parent and provably narrower scope
        v
Native project-scoped Steering
        |
        | explicit authorized Spec selection affects inclusion only
        v
Spec applicability
        |
        | phase/path/task selectors filter only
        v
Task applicability
```

Interoperability and imported resources enter as separate attributed candidates,
not as an implicit tier that overwrites native project content.

A resource records its source `layer`, exact `composition.parents`, and explicit
`composition.overrides`. Parent references include ID, revision, and hash.
Override declarations target an exact parent resource and optionally an exact
rule, select `specialize`, `strengthen`, or `replace`, and include rationale.
Filesystem nesting does not create inheritance by itself.

05C-2 validates parent availability, compatibility, acyclicity, project/control
identity, source eligibility, scope narrowing, and override legality. Missing or
ambiguous parent revisions fail closed. One resource cannot inherit its own
revision lineage or override itself. `supersedes` remains revision history and
cannot substitute for a composition parent.

Template updates never mutate adopted project revisions. A project may explicitly
adopt a new template revision and publish a new project revision. Import updates
follow the same exact-source rule.

## Semantic precedence and project overrides

Precedence is a partial semantic relation, not a total file order. An applicable
declaration defeats another declaration only when all of these are true:

1. the lower declaration has an explicit override targeting the exact upstream
   resource/rule revision;
2. the target's override policy allows that mode;
3. the lower scope is equal where replacement is allowed or is provably narrower
   where specialization is required;
4. the lower authority does not weaken the target authority;
5. required enforcement and capability restriction layers are retained or
   strengthened;
6. project/control identity and provenance rules permit the relationship;
7. both exact revisions and all referenced mechanisms are valid and compatible.

`sealed` rejects descendant override. `narrower-scope` allows only an explicit,
provably narrower specialization or strengthening. `explicit-replacement`
allows an explicit equal/narrower replacement for descriptive or normative
content. Enforceable declarations can never use explicit replacement and can
only be strengthened.

The conservative scope proof rules are fixed:

- any valid non-global scope is narrower than project-global;
- exact path is narrower than the same exact path or a containing tree;
- a descendant tree is narrower than its ancestor tree;
- phase, Spec-kind, and task-kind sets are narrower only by exact set inclusion;
- identical deterministic globs are equal, but general glob subset inference is
  not attempted;
- composite implication is accepted only when normalized structural rules prove
  it; inability to prove narrowing is failure, not guessed precedence.

Explicit Spec selection and task applicability select candidates. They do not
create override authority. An imported or interoperability resource cannot
replace native enforceable policy. A project can adopt its content into a new
native revision and then apply the ordinary project override rules.

No conflict can be resolved by filesystem enumeration, lexical filename,
resource array order, prompt position, insertion order, timestamp, or last write.
Canonical sorting exists only for reproducibility and diagnostics.

## Conflict semantics

05C-2 groups active applicable structured rules by semantic key after scope and
inclusion. The conservative compatibility rules are:

- identical effect and canonical value are compatible duplicates, with every
  source retained in provenance;
- `forbid` of different values is cumulative;
- `require X` and `forbid X` conflict;
- different `require` values under one semantic key conflict;
- different `describe` or `prefer` values under one semantic key conflict;
- rules under different semantic keys are independent unless an explicit
  relationship declares otherwise.

A legal explicit override can select one result while retaining a decision record
for every displaced declaration. Without that relation, incompatible equal or
unordered declarations produce a conflict. Required conflicts fail resolution.
Optional conflicting resources may be omitted only if omission cannot weaken a
required or enforceable declaration; the omission and reason remain a diagnostic.

A resolver does not infer arbitrary English equivalence or contradiction.
Normative authoring/review is responsible for stable semantic keys and values.
Opaque prose suspected to conflict produces an unresolved semantic-conflict
finding rather than a fabricated machine decision. Thus declarations equivalent
to "handlers must use repositories" and "handlers may query the database"
share an authored semantic key and conflict unless a valid scoped override exists.

Required enforceable security/capability denials are monotone. Lower-level allow,
replacement, manual selection, task content, worker output, or prompt order cannot
weaken them. Existing capability composition remains deny-wins.

## SteeringSnapshot target contract

05C-3A implements `aira.dev/steering-snapshot/v1`. A successful snapshot contains
enough immutable information to reconstruct exactly what governed one action:

- schema and `SteeringSnapshotId`;
- project/control identity;
- snapshot content hash and byte identity under an explicit encoding;
- resolver implementation/version and exact resolver policy/profile;
- resolution request selectors: phase, optional Spec ID/kind/custom kind,
  optional Task ID/kind/custom kind, known touched paths or path observation,
  and authorized manual selections;
- exact included resource IDs, revision IDs, content hashes, kinds, custom kinds,
  source layers, and provenance;
- effective resource/rule authority and active status;
- resource and rule inclusion reasons;
- resolved resource and rule scopes;
- deterministic entry and rule order;
- exact parent, adoption, override, duplicate, and compatibility decisions;
- every resolved enforcement binding and whether it is advisory or required;
- successful conflict-resolution results and full source provenance;
- exact omitted-optional diagnostics;
- creation metadata, with timestamps treated only as metadata.

Each entry references an exact revision and hash. No entry can mean "current
Steering", "read this path later", or "use latest". A snapshot cannot be
published with unresolved required conflicts, missing required resources,
unknown schema versions, incompatible required extensions, unverifiable source
bytes, or absent required enforcement mechanisms.

The snapshot body hash covers all meaning-bearing resolution inputs, entries,
orders, provenance, and decisions. The self identity and non-semantic creation
timestamp are outside that hash subject. Deterministic order is defined by
semantic layer decision plus resource ID, revision, rule ID, and binding identity,
all in code-point order where a semantic rank does not apply. Timestamp never
breaks ties.

A snapshot stores resolved decisions, not only inputs. 05C-3A construction accepts
only a successful detached 05C-2 result and structurally validates its exact
references and decisions without rerunning resolution. A future integrity check
may replay the pure 05C-2 resolver only when given the original exact catalog; it
must never resolve current project files as a substitute. Historical inspection
can display a snapshot without re-resolving current project files.

## Version changes and staleness

Changing Steering publishes a new immutable revision and does not mutate an old
snapshot or any artifact that pins it.

Future planning provenance records exact SteeringSnapshot dependencies and, when
available, the exact resource/rule entries actually consumed by an artifact.
Staleness is causal:

1. re-resolve for the artifact's recorded phase, Spec kind, path scope, task kind,
   and manual selections;
2. compare the effective relevant resource/rule revision, authority, scope,
   semantic value, and enforcement set;
3. mark only artifacts whose declared effective dependencies changed;
4. propagate through the existing explicit planning lineage and applicability
   rules.

An unrelated operations-rule edit need not stale Product authoring. A scoped API
rule need not stale work outside that path. A relevant normative or enforceable
change blocks reuse until re-analysis/revalidation required by policy. A relevant
descriptive change can mark context stale without fabricating a policy breach.
Removing content required by a pinned snapshot makes loading that snapshot an
integrity failure, not a reason to substitute a newer revision.

The crude rule "any Steering edit invalidates every Spec" is forbidden. Missing
fine-grained dependency evidence can conservatively stale a larger declared
scope, but it cannot broaden historical applicability or rewrite snapshot meaning.

## Relationship with Specs and Context

Steering revisions are project resources, not canonical Spec artifacts. They do
not become Product, Requirements, Architecture, Program Design, Slices, or Tasks.
A future Spec authoring/analysis record references the exact SteeringSnapshot
used. A Spec can explicitly select eligible Steering for a resolution request,
but that selection does not transfer ownership or authorize an override.

A future `ContextSnapshot` contains or references an exact SteeringSnapshot plus
Spec planning artifacts, declared project context, task-specific context, and
other immutable inputs. Steering answers what persistent project knowledge and
rules apply. Context answers what exact information the worker/action receives.
A Context implementation may render selected Steering bodies, but the exact
SteeringSnapshot remains the authority and provenance source.

05C-1 does not modify the current Context resolver or filesystem declarations.
Context integration must be versioned and non-breaking in its own stage. A
missing Steering snapshot required by a Context snapshot fails before dispatch.
Neither Context nor Steering grants capabilities.

## Relationship with behavioral assets

Behavioral assets define how Aira performs generation, analysis, execution, and
review. Steering defines the project knowledge and rules governing that work.
For example, architecture analysis combines an exact architecture-analysis
behavioral asset, exact project architecture Steering, current Requirements, and
the Architecture proposal.

Steering body bytes are not embedded in a prompt asset. Behavioral defaults do
not select current Steering. Both are independently versioned and independently
pinned. A Steering revision generated or analyzed by Aira records exact behavioral
attribution, while the resulting Steering remains project input after authorized
adoption.

## Relationship with capability policy and verifiers

A normative sentence never becomes a hard restriction by inclusion in a prompt.
An enforceable Steering rule names an existing exact Policy or Verifier mechanism.
The referenced mechanism's own domain, compatibility, backend checks, execution,
evidence, and storage rules remain authoritative.

Capability restrictions retain all applicable layers and deny wins. Steering has
no escalation authority and cannot claim that Pi hooks, a worktree, a model
promise, or a verifier description supplies missing confinement. Verifier links
identify actual revision/hash inputs and later evidence; this slice runs none.

## AGENTS.md interoperability

05C-4 supplies the adapter. The target contract is:

- `AGENTS.md` is an interoperability input, not authoritative Aira state by
  existence alone;
- direct use requires an enabled exact adapter profile and an authorized,
  deterministic inclusion policy;
- source locator, exact raw bytes/hash, adapter revision, scope, and inclusion
  reason are preserved;
- root `AGENTS.md` can use the well-known logical interop resource
  `interop.steering.agents-md`;
- additional scoped `AGENTS.md` sources require an explicit stable logical
  resource mapping and scope declaration, so their Steering identity is not a
  hidden derivative of a filesystem path;
- moving a mapped source changes source provenance, not its logical identity;
- arbitrary prose imports as descriptive or normative guidance at most;
  enforceable authority requires explicit project adoption plus real bindings;
- native Steering conflict rules apply, and direct interoperability can never
  silently replace native enforceable security/capability restrictions;
- every directly used source hash is pinned in the SteeringSnapshot;
- edits create a new observed/imported revision and never mutate a historical
  snapshot.

Discovery must be bounded, symlink-safe, race-aware, workspace-relative, and
exact-byte preserving. Those filesystem requirements belong to 05C-4, not the
pure 05C-1 domain.

## Storage and publication target

05C-3B1 stores the authoritative project registry, immutable revision envelopes,
and exact body blobs through the provider-neutral `SteeringStore` and existing
`BlobStore`. File-backed publication uses the established immutable records,
commit, HEAD, lock, fsync, recovery, and CAS rules. Steering does not get a weaker
mutable side store. 05C-3B2 stores complete `SteeringSnapshot` records in BlobStore
and uses one deterministic immutable, integrity-checked locator per snapshot ID.
Snapshot publication does not mutate Steering HEAD or either Steering counter.

The file layout is rooted at `.aira/state/v2/steering/`, with one strict Steering
HEAD and immutable content-hash-named commits. Exact canonical revision records
and unmodified raw bodies use the shared `.aira/state/v2/blobs/sha256/` store.
Steering resource IDs and project identity are not filesystem path segments, and
Steering is never stored under a fabricated `SpecId`. The exact schemas and
transaction protocol are documented in
[steering-store-05c3b1.md](steering-store-05c3b1.md).

An authoritative project Steering registry selects exact resource revisions and
retains their immutable history. Its canonical decimal-u64 `SteeringGeneration`
is distinct from CommitSequence, SpecGeneration, and RunGeneration. Semantic
registry mutations advance it exactly once; audit-only commits and reads do not.
Views or materialized Markdown are rebuildable and non-authoritative. A default
future path such as `.aira/steering/architecture.md` is an adapter convention,
not identity. Orphan blobs, revision records, and commits are not authority.
Every registry update is transactionally checked against exact HEAD, sequence,
generation, affected-resource revision expectations, and OperationId.

Historical persisted objects and every referenced revision/body needed to inspect
them are retained according to storage policy. If a pinned object is missing or
hash-mismatched, use fails closed. Current files are never substituted. Persisted
05C-3B2 snapshots, exact historical registry attribution, and pinned bindings
follow the same retained, fail-closed rule.

## Security and authority boundaries

Imported prose and repository content are untrusted data with respect to prompt
injection and capability grants. Rendering Steering into Context does not execute
it, authenticate it, or authorize tools.

Workers receive pinned Steering and can propose changes, but they cannot publish,
adopt, select manual constraints, alter bindings, or update authoritative
Steering through their own output. Mutation requires a trusted project-control
operation, expected-state checks, authorization provenance, schema and
relationship validation, and later transactional publication. The same worker
cannot silently redefine the constraints governing its attempt.

Resolvers and adapters enforce size/count/depth limits, strict schemas,
canonical logical paths, safe source handling, exact hashes, and deterministic
diagnostics. Required extension or enforcement mechanisms are authenticated
before use. Human-readable labels, filenames, Markdown headings, timestamps,
and model assertions carry no authority.

## Diagnostics

Validation and resolution expose stable structured issue codes plus subjects and
related identities. User-facing prose can explain them but is not the API.
Diagnostics are deduplicated and sorted deterministically.

The complete implementation includes codes for at least:

- invalid resource, revision, rule, kind, custom category, authority, scope,
  inclusion, provenance, compatibility, and binding;
- immutable overwrite, identity reassignment, invalid/missing predecessor, and
  revision branch;
- content/source/observed hash mismatch;
- missing required resource, parent, body, snapshot, policy, verifier, adapter,
  or extension;
- unauthorized manual inclusion or Steering mutation;
- parent cycle, unprovable scope narrowing, illegal override, authority downgrade,
  and attempted enforceable/capability weakening;
- duplicate or conflicting binding identity;
- structured semantic conflict and unresolved opaque semantic conflict;
- stale planning dependency and incompatible resolver/schema version.

Required failures block snapshot publication or dispatch. Optional omissions are
recorded, never silent.

## Release completeness

The normative release gates are expanded in
[release-completeness.md](release-completeness.md). Aira v2 is not Steering-complete
without production-grade product, architecture, technology, structure,
engineering, testing, security, and operations Steering templates or generators;
custom authoring documentation; inclusion, scope, authority, enforcement,
conflict, provenance, snapshot, staleness, and AGENTS interoperability reference
documentation; and complete tested examples.

Schema correctness and placeholder documents are insufficient. This stage does
not author final built-in content or change `aira init`.

## Implementation sequence

### 05C-1: pure foundation, implemented

- this master contract;
- ADR-013 and stable invariants;
- pure logical identities and immutable revision references;
- resource kinds, structured rules, provenance, layers, composition declarations;
- strict authority and typed enforcement linkage;
- scope and inclusion declarations;
- deterministic structural validation and focused boundary/domain tests.

### 05C-2: deterministic composition, implemented

- exact candidate catalog and resolution request;
- hierarchy and parent DAG validation;
- inheritance and explicit project overrides;
- provable scope narrowing and semantic precedence;
- structured conflict detection and stable diagnostics;
- monotone enforceable/capability non-weakening;
- pure deterministic resolution, without filesystem discovery.

The implemented policy is `aira.dev/steering-policy/conservative/v1` under
`aira.dev/steering-resolution/v1`. Its [algorithm and pure request/result
contract](steering-resolution-05c2.md) specify region-preserving explicit
overrides, exact provenance, enforcement retention, deterministic ordering, and
fail-closed choices for otherwise unspecified mixed effects, optional conflict
omission, and manual authorization. Specificity and inclusion never independently
authorize overrides. These policy semantics are version-pinned; the strict
05C-1 revision decoder and exact body-byte contract remain unchanged.

### 05C-3A: SteeringSnapshot and causal staleness, implemented

- exact snapshot schema, identity, canonical body encoding, and semantic hash subject;
- complete successful resolution decisions and provenance;
- immutable whole-snapshot and declared fine-grained dependency bindings;
- exact Steering change observations and pure causal staleness;
- no persistence, current pointer, store adapter, or CAS operation.

### 05C-3B1: project Steering registry persistence, implemented

- provider-neutral `SteeringStore` and existing BlobStore integration;
- authoritative project registry and distinct `SteeringGeneration`;
- immutable revision records and exact raw body publication;
- strict Steering commit chain and atomic Steering HEAD;
- explicit HEAD/generation/resource CAS and OperationId idempotency;
- independent project Steering lock using the certified lock protocol;
- exact retention, current-load integrity, and deep history verification.

### 05C-3B2: snapshot persistence and crash audit, implemented

- reusable immutable SteeringSnapshot record publication and lookup;
- deterministic immutable locator and retained content-addressed records;
- exact reachable historical registry attribution and deep closure verification;
- no Steering generation, commit, or HEAD mutation during snapshot publication;
- broader combined resource/snapshot crash, concurrency, and path-integrity hardening.

### 05C-4: project resource adapters

#### 05C-4A1: native source inspection, implemented

- versioned strict Markdown/frontmatter authoring contract;
- exact complete-source and body-byte identities;
- bounded, symlink-safe, race-aware `.aira/steering/**` discovery;
- stable logical mapping independent of materialization path;
- project source provenance, structured duplicate diagnostics, and exact
  mutation comparison;
- read-only source proposals with no registry, BlobStore, resolver, or Context
  mutation.

#### 05C-4A2A: explicit native-source adoption, implemented

- immutable `aira.dev/steering-adoption-plan/v1` construction from exact native
  source observations and exact registry authority;
- explicit human authorization, worker self-modification rejection, source and
  registry freshness checks, deterministic revision allocation, and one
  SteeringStore CAS batch publication;
- immutable project revision provenance that retains the exact adopted native
  source observation;
- no-op, partial-selection, cross-reference, and OperationId replay semantics;
- no source deletion inference and no registry-to-file materialization.

#### 05C-4A2B: authoritative native-source materialization, implemented

- immutable `aira.dev/steering-materialization-plan/v1` construction from exact
  registry authority, raw body blobs, and exact native target observations;
- deterministic `aira.dev/steering-source/v1` rendering with exact body bytes
  and parser-proven authorable semantic round trip;
- create, unchanged, explicitly authorized replace, and human-preserving conflict
  actions with authority and target freshness checks;
- safe bound-directory creation and crash-safe per-file temporary, fsync, rename,
  and directory-fsync publication with explicit partial-result semantics;
- no Steering registry, generation, commit, revision, snapshot, or blob mutation.

#### Deferred 05C-4B

- template instantiation/materialization and template catalog authentication
  beyond native project source adoption;
- bounded, safe `AGENTS.md` interoperability;
- Context-facing adapter inputs; worker and prompt delivery belongs to the later
  Context/worker integration stage, not 05C-4.

### 05C-5: adversarial and integration audit

- contradictory equal/scoped rules and malicious override attempts;
- path traversal, symlink, source mutation, and unsafe discovery cases;
- stale and missing snapshots/revisions/blobs;
- forged template/import provenance and mixed provenance;
- binding identity/hash/backend integrity;
- worker self-modification attempts;
- architecture dependency-boundary review and full regression validation.

## 05C-1 exclusions

05C-1 does not implement inheritance, conflict resolution, filesystem discovery,
materialization, an `AGENTS.md` adapter, snapshot construction/resolution,
Steering storage/CAS, Context resolution, WorkspaceProvider, worker or prompt
integration, capability/verifier execution, scheduling, CLI/Pi UX, production
Steering content, `aira init` generation, or automatic LLM generation. The pure
composition fields and snapshot identity reserve the final contract boundary;
they do not perform later-slice work.
