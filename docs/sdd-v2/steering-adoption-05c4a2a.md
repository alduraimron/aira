# Steering 05C-4A2A: native source adoption into authority

Status: implemented. This slice adds explicit adoption of reviewed native
Steering sources. It extends the read-only native source contract in
[05C-4A1](steering-native-source-05c4a1.md) and the authoritative registry
contract in [05C-3B1](steering-store-05c3b1.md).

## Authority boundary

An authoring file is not authority:

```text
.aira/steering/**             authoring input
.aira/state/v2/steering/**    authoritative project Steering
```

Editing, moving, copying, or deleting a native source never changes the
registry, a current revision, Steering HEAD, or SteeringGeneration. An explicit
adoption operation is the only native-source-to-authority path implemented by
this slice.

```text
inspect
  -> deterministic immutable plan
  -> explicit human authorization
  -> source freshness check
  -> registry freshness check
  -> one SteeringStore CAS transaction
  -> immutable revision/body publication
```

There is no registry-to-file materialization in this slice.

## Application boundary

`src/steering-adoption/` is the application layer between the existing pure
Steering domain, the 05C-4A1 source adapter, and `SteeringStore`:

- `types.ts` defines strict plan, authorization, result, action, and issue
  contracts.
- `plan.ts` compares an already-complete source inspection with an exact
  registry observation and constructs pure next revisions.
- `apply.ts` receives human authorization, re-inspects sources, verifies
  freshness, and executes a short store transaction.

The pure `src/steering/**` domain does not read authoring files. Adoption does
not run the resolver, Context, Pi, CLI, worker runtime, verifiers, or a
materializer.

## Immutable adoption plan

The plan schema is `aira.dev/steering-adoption-plan/v1`. Its full SHA-256
semantic hash produces a full-digest `steering_adoption_plan_<digest>` identity.
The plan contains:

- project and source-root control identity;
- fixed native discovery, source, and observation contract versions;
- every exact source observation and parsed proposal covered by an action;
- exact source complete hash and byte count, body hash and byte count,
  metadata hash, logical identity, logical path, provenance, and opened-file
  observation;
- authoritative registry absence or exact HEAD, CommitSequence,
  SteeringGeneration, and current resource expectations;
- concrete create, update, unchanged, or conflict actions;
- concrete selected action IDs, never a floating "all changed" alias;
- required human authorization and worker self-modification prohibition; and
- the explicit SteeringStore OperationId/idempotency requirement.

Plan construction is read-only. It does not initialize state, write a blob,
create a directory, advance a generation, or take a Steering writer lock.

Plan and action semantic identity canonicalize JSON and omit diagnostic
filesystem fields that are not native v1 replacement identity, including
mtime/ctime. Source path, complete source hash, body hash, metadata hash,
logical identity, discovery policy, provenance, and filesystem kind/device/inode
replacement identity remain bound.

## Registry comparison and action classification

Comparison uses logical `SteeringResourceId`, not a filename. It compares a
native proposal with the exact current authoritative revision's body descriptor,
kind, layer, metadata, rule inventory and semantics, scope, inclusion,
composition, compatibility, behavioral attribution, provenance, predecessor
history, and source-adoption attribution.

Actions are:

- `create`: the resource is absent and revision `1` is bound in the plan.
- `update`: the resource is active and a deterministic successor revision and
  exact predecessor are bound in the plan.
- `unchanged`: body, structured semantics, metadata, and authoritative source
  attribution already equal the reviewed proposal.
- `conflict`: publication cannot safely map to current authority, including a
  retired ID, invalid history, provenance incompatibility, or invalid reference
  closure.

Diagnostics independently identify body, metadata, rules, and provenance
changes. A body-only edit can remain body-only even though structured rule source
locations carry the new body hash. A source-only provenance change can require a
new revision because the authority must retain the exact source observation from
which it was adopted. The narrow 05C-4A2B exception is a byte-exact deterministic
materialization of the current revision: re-adopting that projection is a no-op
rather than an artificial source-lineage successor.

## Revision and provenance construction

Adoption creates the existing `aira.dev/steering-resource/v1` revision. It does
not define a second revision format. Create uses revision `1`; update allocates
one greater than the authoritative current revision under the existing decimal
u64 and linear predecessor rules. Timestamps never allocate revision identity.

The resulting revision has project provenance plus immutable `native_source`
attribution. That attribution preserves the complete 05C-4A1 source observation:
logical source path, source and body descriptors, metadata hash, source schema,
discovery policy, project/control identity, parsed logical identity, source
provenance, and filesystem replacement observation. It proves both that the
revision is project authority and that it was adopted from one exact reviewed
native source. The source path is not the resource identity.

The exact `body_bytes` returned by reinspection are passed to `SteeringStore`.
No trimming, decoding/re-encoding, newline conversion, Markdown rewrite, or
second body store occurs. BlobStore and SteeringStore retain immutable body and
revision publication responsibility.

## Two-dimensional freshness

A normal application is valid only when both dimensions are exact:

```text
reviewed selected source observations
             +
reviewed authoritative registry observation
```

Before a mutation, apply re-inspects every selected source and uses the 05C-4A1
exact observation comparator. It detects complete-byte changes, body changes,
metadata changes, logical identity changes, source replacement, path changes,
provenance changes, and discovery-policy incompatibility. A stale plan is not
regenerated.

Apply then loads the registry and compares the plan's exact HEAD,
CommitSequence, SteeringGeneration, and full observed resource expectations.
The transaction also supplies exact expectations for every published resource.
A changed registry fails rather than rebasing.

The stable application issues are `adoption-plan-source-stale` and
`adoption-plan-registry-stale`. Both may be returned when both dimensions
changed. Storage-level failures remain storage errors.

A completed OperationId retry is the narrow exception to preflight freshness:
it delegates to SteeringStore's reachable-operation replay before attempting a
new mutation. It cannot publish changed current sources or state.

## Authorization and worker boundary

Apply requires an explicit
`aira.dev/steering-adoption-authorization/v1` record naming the exact plan
identity/hash, project, local human-compatible actor, decision time, and channel.
A human actor such as `{ kind: "human", id: "local" }` is accepted.

A model or worker actor is rejected with `adoption-worker-unauthorized`; a
missing, malformed, mismatched, system, or nonhuman authorization is rejected
with `adoption-authorization-required`. The adoption API does not treat a
worker result as equivalent to a human decision. The store transaction receives
only the authorized human actor. This preserves ADR-013 and INV-STEER-007: a
worker cannot directly authorize a change to the constraints governing itself.

No confirmation UI is implemented here.

## Atomic batch and partial selection

A plan may select multiple concrete create, update, or unchanged action IDs.
The selection is resolved during planning and is part of plan identity. Apply
accepts no mutable selection parameter.

All selected create/update actions are assembled into one resulting registry and
one SteeringStore `create` or `publish` transaction. One existing-registry
semantic batch advances SteeringGeneration exactly once. Either every selected
revision becomes current through the one HEAD change or none does.

Before publication, the resulting revision closure is checked without running
the resolver. Exact parents, overrides and target rules, adopted revision
references, history, hierarchy, scope narrowing, and resulting registry
integrity must all be available. If a selected source refers to a planned
revision omitted by partial selection, planning rejects it with
`adoption-partial-selection-invalid`. Broken closure reports
`adoption-cross-reference-invalid` or `adoption-resource-conflict`.

## No-op, retirement, and source removal

A selected set containing only unchanged actions returns structured `no-op` with
`adoption-no-op`. It does not write a blob, publish an audit-only commit, advance
CommitSequence, or advance SteeringGeneration. This deliberately favors no
authority mutation for a pure no-op. No-op calls still require an explicit human
authorization and exact registry freshness.

Retirement execution is intentionally deferred. No plan action infers retirement
from missing source files. If `steering.architecture` is authoritative and its
native file disappears, inspection reports source absence, planning contains no
retire action, and the existing active authoritative resource remains current.
A future explicit retirement operation must bind exact current authority,
human intent, and downstream closure validation. Retired IDs remain nonreusable.

## OperationId and result

Plan identity and storage OperationId are distinct. The plan identifies reviewed
semantic intent. OperationId identifies one storage transaction for durable
idempotency. The transaction marker binds both the plan identity/hash and the
exact authorization decision, so reuse of one OperationId for a different plan
or authorization intent is `STORE_OPERATION_REUSE`.

A successful result exposes:

- plan identity/hash and OperationId;
- committed or replayed status;
- previous and resulting HEAD/SteeringGeneration;
- created and updated exact revision references;
- unchanged and retired resource lists;
- authoritative commit ID; and
- exact selected source observations used.

A same-plan, same-OperationId retry converges on the original committed result
with `replayed: true`. Different OperationIds racing from one expected registry
state have one CAS winner; the loser receives stale-registry conflict and no
auto-merge occurs.

## Deferred work

05C-4A2B remains deferred: registry-to-file materialization, source-file
writing, and template materialization are not implemented. 05C-4B remains
deferred: `AGENTS.md` interoperability has separate provenance semantics.
Context/worker delivery, runtime enforcement, verifier execution, scheduling,
CLI/Pi UX, template generation, GC, and Git operations also remain outside this
slice.
