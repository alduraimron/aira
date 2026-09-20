# Steering 05C-4B2: reviewed AGENTS.md import and composition

Status: implemented. This slice composes explicitly reviewed `AGENTS.md`
observations into authoritative Steering without treating free-form prose as
native structured Steering.

It extends the read-only [05C-4B1 observation adapter](steering-agents-interop-05c4b1.md),
the [Steering contract](steering-contract.md), the [resolver](steering-resolution-05c2.md),
the [snapshot contract](steering-snapshot-05c3a.md), and the authoritative
[SteeringStore](steering-store-05c3b1.md).

## Boundary and flow

`AGENTS.md` remains interoperability guidance. Its existence, author, file
ownership, headings, Markdown, or words such as "must" and "never" do not make
it native Aira policy or a machine enforcement boundary.

The only implemented authority-changing path is:

```text
AGENTS.md
  -> 05C-4B1 exact observation
  -> immutable 05C-4B2 import plan
  -> explicit human authorization
  -> source freshness verification
  -> exact mapping to a Steering revision
  -> one SteeringStore CAS publication
  -> ordinary resolver and snapshot consumption
```

The application layer is deliberately separate from both pure Steering and the
read-only adapter:

```text
src/steering-agents-import/
  types.ts    strict policy, plan, authorization, result, and diagnostics
  mapping.ts  deterministic identity, scope, provenance, and raw-resource mapping
  plan.ts     read-only inspection and registry comparison
  apply.ts    authorization, freshness, closure validation, and SteeringStore CAS
  index.ts    public API
```

`src/steering-agents/` remains read-only. This slice does not write AGENTS
files, materialize files, invoke the resolver while publishing, call an LLM,
deliver Context, prompt workers, synthesize capabilities, synthesize verifiers,
or add a watcher, scheduler, CLI, Pi UX, GC, or Git operation.

## Versioned import policy

The fixed v1 policy is:

```text
aira.dev/steering-agents-import-policy/v1
```

Its SHA-256 pin is stored in every plan and imported revision. The policy
explicitly fixes all of the following rather than relying on mutable adapter
defaults:

- source-location to logical-resource mapping under
  `aira.dev/steering-agents-import-mapping/v1`;
- root and nested scope translation;
- `custom` resource representation with custom category
  `agents.interoperability`;
- `interoperability` layer and provenance;
- exact raw-byte body behavior;
- default normative authority and the descriptive/normative ceiling;
- no structured rules, enforcement bindings, parents, or overrides;
- all-phase inclusion with explicit path scope filtering;
- broadest-to-nearest presentation metadata;
- same-location successor revisions, moved-location new identities, and no
automatic retirement.

The policy is exposed as `agentsImportPolicy`. Its adapter profile is exact and
versioned, but it is not an enforcement mechanism.

## Stable source-to-resource identity

A source is first validated by 05C-4B1 as a safe logical project-relative
location. The v1 mapper does not use a raw host filesystem path.

```text
AGENTS.md
  -> interop.steering.agents-md

packages/api/AGENTS.md
  -> interop.steering.agents-md.location-<32 SHA-256 hex>.hash-<32 SHA-256 hex>
```

The nested digest is over the versioned mapping contract, source type, validated
logical source path, and deterministic scope root. It does not include body
bytes. Therefore an edit to one source publishes a new revision of the same
logical resource, while a root and nested source are distinct. Collision checks
reject duplicate source locations or any plan that would map different sources
to one resource.

Under v1, moving `packages/api/AGENTS.md` to `services/api/AGENTS.md` changes
its logical interoperability source location and maps to a new resource ID. The
old imported resource remains authoritative until a future explicit retirement
or migration operation changes it. Filesystem disappearance never deletes or
retires authority.

## Imported resource representation

Each selected valid observation becomes an ordinary
`aira.dev/steering-resource/v1` revision:

| Field | v1 value |
| --- | --- |
| resource kind | `custom` |
| custom kind | `agents.interoperability` |
| layer | `interoperability` |
| provenance kind | `interoperability` |
| body | exact reviewed `AGENTS.md` raw bytes |
| encoding | `aira.dev/steering-bytes/raw/v1` |
| rules | empty |
| default authority | `normative` |
| default override policy | `sealed` |
| default enforcement | empty |
| composition parents and overrides | empty |

The body receives no frontmatter, wrapping, trimming, line-ending conversion,
Unicode normalization, Markdown parsing, heading extraction, or transformation.
Its immutable Steering body hash and byte count equal the reviewed observation's
exact descriptor.

The revision provenance retains an exact `agents-md` source reference and a
05C-4B1 attribution with:

- source type `AGENTS.md`;
- project-relative source path;
- source location identity and exact observation identity;
- exact raw source hash, byte count, and media type;
- scope root and depth;
- raw-byte and UTF-8 contracts;
- discovery policy/version;
- 05C-4B1 interoperability provenance; and
- import policy/version and hash.

The raw bytes themselves are the ordinary immutable Steering body blob. The
attribution therefore does not duplicate body bytes while still retaining their
exact identity and reviewed observation.

## Authority, rules, and enforcement

V1 chooses normative guidance because AGENTS files conventionally guide agents.
That choice is policy data, not a behavior hidden in code. Raw AGENTS imports
can never be `enforceable` in v1. A malformed or preexisting mapped resource
claiming enforceable authority fails import validation.

No sentence is converted to a `SteeringRule`. In particular, v1 does not infer:

- semantic keys, effects, JSON values, or rule IDs;
- architecture or security policy;
- override declarations;
- capability-policy bindings;
- verifier, repository-check, or extension bindings; or
- any other enforcement from prose.

Imported raw resources have zero structured rules and zero enforcement bindings.
A resource that claims otherwise is rejected with stable
`agents-import-authority-invalid`, `agents-import-enforcement-forbidden`, or
`agents-import-mapping-conflict` diagnostics as appropriate.

A later typed, authorized mapping mechanism would be a separate versioned slice.
It must not relabel raw AGENTS prose in place.

## Scope, inclusion, and nested guidance ordering

05C-4B1 lexical scope maps into existing Steering scope grammar:

```text
AGENTS.md                    -> project-global
packages/api/AGENTS.md       -> path tree packages/api
packages/api/src/AGENTS.md   -> path tree packages/api/src
```

Every imported resource uses explicit required `always` inclusion. Its scope
then filters applicability for all Steering phases. A caller must still provide
known touched paths for a nested path scope. No cwd or runtime filesystem lookup
is used to infer applicability.

The resolver evaluates normal resource inclusion and scope. It sees a selected
imported resource and preserves its body descriptor and provenance, but sees no
AGENTS structured rule because none exists.

For later Context presentation, provenance preserves source path and scope root.
`compareAgentsImportedGuidance` reconstructs deterministic guidance display
order by scope depth and source path:

```text
broadest -> nearest
```

This is interoperability presentation order only. It is not resource hierarchy,
semantic precedence, an override edge, or a capability grant. The resolver's
native semantic ordering is intentionally unchanged.

## Native Steering coexistence

Imported guidance is an attributed candidate alongside native Steering. It does
not inherit native rules, declare a parent, target an override, shadow a native
rule, weaken a sealed native rule, or alter semantic-key selection.

For example, a native structured rule requiring a service layer remains the
only structured semantic authority even if imported prose says that handlers may
directly access a database. The imported body can coexist in the resolved
resource inventory, but no false structured conflict or English-language
comparison is generated.

## Immutable import plan

The plan schema is:

```text
aira.dev/steering-agents-import-plan/v1
```

Its full canonical semantic SHA-256 produces:

```text
steering_agents_import_plan_<64 lowercase hex>
```

Planning is read-only. It receives a complete valid 05C-4B1 inspection and an
exact Steering registry observation. It does not create a registry, blob,
snapshot, directory, source file, writer lock, or generation advance.

A plan pins:

- project identity and logical control root `.`;
- exact 05C-4B1 discovery and observation contracts;
- the complete versioned import policy and policy hash;
- every action's exact observation descriptor, source identity, observation
  identity, provenance, mapping, scope, inclusion, and resulting provenance;
- mapped resource ID and action identity;
- exact registry absence, or HEAD, CommitSequence, SteeringGeneration, and
  canonical resource expectations;
- concrete `create`, `update`, `unchanged`, or `conflict` actions;
- immutable selected action IDs, not a floating "all current changes" alias;
- explicit human authorization requirements; and
- required SteeringStore OperationId semantics.

Planning accepts an optional exact list of logical AGENTS source paths. It
resolves that request to immutable action IDs before returning the plan. Apply
accepts no selection parameter. Invalid selection, duplicate selection, omitted
invalid closure, or conflict selection fails with
`agents-import-partial-selection-invalid`.

Action classification is conservative:

- `create`: the mapped resource is absent;
- `update`: the mapped resource is a compatible raw v1 AGENTS resource but any
  body, observation, provenance, mapping, scope, inclusion, authority,
  representation, composition, compatibility, or metadata meaning differs;
- `unchanged`: all authoritative meaning already equals the reviewed source
  under this exact policy;
- `conflict`: a retired ID, incompatible source attribution, invalid raw
  representation, collision, or unsafe evolution cannot be proven safe.

An absent AGENTS file produces no retirement action.

## Authorization and two-dimensional freshness

Apply requires an exact
`aira.dev/steering-agents-import-authorization/v1` decision over the plan
identity/hash and project. Only a human actor is accepted. Missing, malformed,
mismatched, worker, and model authorization are rejected. A model or worker
cannot authorize the constraints that govern its own work.

Before publication, apply validates both independent dimensions:

```text
reviewed selected AGENTS observations
             +
reviewed authoritative Steering registry
```

Selected sources are re-inspected through 05C-4B1. Apply rejects changed bytes,
source replacement, moved path, changed scope, changed observation identity,
incompatible discovery or import policy, unsafe source, and missing source. It
never silently rebuilds a plan from current files.

The registry check validates exact planned HEAD, CommitSequence,
SteeringGeneration, and resource expectations. The transaction repeats affected
resource expectations under the Steering writer lock. There is no automatic
rebase or auto-merge. Both source and registry stale diagnostics can be returned
from one attempt.

## Publication, batch, no-op, and concurrency behavior

Apply constructs standard immutable Steering revisions with normal predecessor
history and passes exact re-observed body bytes to `SteeringStore`. It validates
the resulting registry closure without resolving prose, then publishes all
selected `create` and `update` actions in one store transaction. The batch either
changes authority together or does not change it at all.

The structured result schema is:

```text
aira.dev/steering-agents-import-result/v1
```

It reports plan identity, OperationId, committed/replayed/no-op status, previous
and current HEAD/generation, created and updated revision references, unchanged
resources, exact imported observation descriptors, authoritative commit, and
stable diagnostics.

A selected unchanged-only plan is a no-op. It requires fresh human authorization
and fresh registry/source observations but does not publish a blob or commit and
does not advance SteeringGeneration. A no-op does not create a registry merely
because no registry exists.

A committed same-plan, same-OperationId retry replays the original store
transaction. Reusing that OperationId for another plan or authorization intent
returns `STORE_OPERATION_REUSE`. Different OperationIds from one expected HEAD
race through ordinary SteeringStore CAS: one wins and the other receives
registry-stale failure. A newer import of the same mapped AGENTS resource makes
an older exact plan stale rather than merging revisions.

## Resolver and snapshot integration

No resolver algorithm change is required. Existing 05C-2 behavior already
includes selected resources even when their rule array is empty. Imported AGENTS
resources contribute exact body/provenance/scope/inclusion data and no effective
structured semantic rules or enforcement.

`SteeringSnapshot` already retains complete included revision envelopes. An
imported applicable resource therefore carries into a snapshot:

- exact resource ID and revision;
- exact body hash, size, media type, scope, authority, inclusion declaration,
  and inclusion reason;
- interoperability provenance, source path, source observation identity, and
  import policy pin; and
- the resolver policy that selected it.

A snapshot does not need the mutable AGENTS file to remain meaningful. If A is
imported and pinned in snapshot S1, then source B is later explicitly imported
and pinned in S2, S1 retains A, S2 retains B, and the current registry can point
to B without rewriting S1. Deleting the current AGENTS file does not alter
historical snapshots or automatically retire either resource.

## Stable diagnostics

The public import diagnostics are:

```text
agents-import-plan-invalid
agents-import-source-stale
agents-import-source-missing
agents-import-source-unsafe
agents-import-registry-stale
agents-import-authorization-required
agents-import-worker-unauthorized
agents-import-mapping-conflict
agents-import-resource-collision
agents-import-authority-invalid
agents-import-enforcement-forbidden
agents-import-partial-selection-invalid
agents-import-no-op
```

Precise SteeringStore errors remain storage errors where they are more specific,
including `STORE_OPERATION_REUSE`.

## Explicit limitations

05C-4B2 intentionally does not implement prose interpretation, typed policy
adoption from AGENTS prose, runtime enforcement, capability or verifier
generation, AGENTS writes, materialization, automatic import, Context delivery,
worker prompting, worker integration, scheduling, CLI/Pi UX, templates, GC, or
Git commits. Those require separately versioned work and cannot be inferred from
raw imported guidance.
