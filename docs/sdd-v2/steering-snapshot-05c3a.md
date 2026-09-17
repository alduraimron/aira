# Steering 05C-3A: immutable snapshots and causal dependencies

Status: implemented. This document clarifies the pure 05C-3A slice of the
[master Steering contract](steering-contract.md). The 05C-2
[resolver contract](steering-resolution-05c2.md), [ADR-013](adr/013-project-steering.md),
and INV-STEER-001 through INV-STEER-013 remain normative.

05C-3A implements no persistence, publication, current pointer, filesystem
adapter, Context integration, worker integration, or enforcement execution.
Those boundaries are intentional.

## SteeringSnapshot meaning

`aira.dev/steering-snapshot/v1` answers one historical question:

> Exactly which resolved Steering governed this action?

A snapshot is an immutable copy of one successful, detached 05C-2 result. It is
not a request to resolve again and it contains no `current`, `latest`, path-based,
or generation alias. Later Steering revisions cannot change its meaning.

The snapshot semantic payload retains:

- the project/control namespace;
- the exact resolver contract and conservative v1 policy;
- action selectors, exact selection expectations, authorized manual selections,
  known logical paths, Spec/Task selectors, and compatibility observations;
- hierarchy order and every included exact resource revision;
- resource kind, layer, provenance, raw content hash, byte size, media type,
  scope, inclusion declaration, and inclusion reasons;
- applicable and effective structured rules;
- contributor, equivalent-contributor, region, excluded-region, override, and
  shadow provenance;
- exact typed capability-policy, verifier, repository-check, and extension
  bindings and their source scopes;
- omissions, successful decisions, and deterministic diagnostics.

Raw resource bodies remain identified by their exact raw-byte hashes. Snapshot
construction neither reads nor rewrites those bytes.

## Construction boundary

`buildSteeringSnapshot` accepts only `status: resolved` output from 05C-2. It
rejects conflicted, invalid, incomplete, unsupported-policy, missing-revision,
missing-hash, unresolved-required-input, and structurally inconsistent decision
records with stable lowercase kebab-case codes.

Construction does not call `resolveSteering`. It checks that references and
already-made decisions agree structurally: resources agree with their exact
content metadata and project, contributors exist, regions name contributors,
overrides name present source and target rules, shadow records correspond to
superseding decisions, and aggregate enforcement has every exact source binding.
This freezes 05C-2 decisions without transferring resolution ownership to
05C-3A.

Successful values are canonically detached and deeply frozen. Mutating caller
objects after construction cannot alter the snapshot or its identity.

## Semantic identity and audit metadata

The hash subject is the `semantic` payload. Its byte transformation is exactly:

```text
SteeringSnapshot.semantic
  -> aira.dev/canonical-json/v1 UTF-8 bytes
  -> SHA-256
  -> sha256:<64 lowercase hexadecimal digits>
  -> steering_snapshot_<the same 64 hexadecimal digits>
```

There is no circular hash. The outer `id`, `content` descriptor, and `audit`
object are outside the semantic hash subject. `content.bytes` is the exact
canonical semantic payload byte count and `content.media_type` is
`application/vnd.aira.steering-snapshot+json`.

The provider-neutral canonical JSON and SHA-256 primitive is shared with file
storage. `canonical()`, which is only a domain comparison helper, is not used as
the snapshot byte encoding.

The audit object contains optional `constructed_at` and exact copied resource
creation attribution. Audit values remain inspectable but do not change the
semantic hash or `SteeringSnapshotId`. Exact resource revision, raw content,
provenance, rules, scopes, and decisions remain semantic fields.

Semantic arrays use explicit ordering. Resource and applicable-rule order follows
the resolver's hierarchy/order decisions. Unordered contributor, region,
binding, source, selector input, omission, and diagnostic sets use canonical
code-point order. Authored JSON arrays inside rule semantic values remain ordered
and are never sorted into false equivalence.

## Exact provenance and enforcement

A resource entry never names only a logical resource ID. It contains the exact
`SteeringResourceId`, `SteeringRevisionId`, raw SHA-256 hash, byte size, media
type, kind, layer, and structured provenance.

An effective rule contains all exact contributing authored rules, their exact
resource revisions, applicability scopes, excluded scopes, equivalent
contributors, authority, semantic effect/value, and typed enforcement bindings.
Override declarations, override decisions, and shadow records remain structured.
No caller needs to infer source identity from a title, rationale, or prose.

Enforcement references retain their existing typed Policy, Verifier, Profile,
revision, and hash identities. Snapshot construction validates attribution but
does not compile capability policies or run verifiers, checks, or extensions.

## SteeringDependency

`aira.dev/steering-dependency/v1` is a pure immutable sidecar contract. It binds a
downstream subject to both the exact `SteeringSnapshotId` and semantic snapshot
hash, plus the exact Steering phase and optional structured relevance scope.
It does not mutate planning artifacts.

Planning subjects reuse the existing exact `ArtifactReference` contract and map
to all six canonical planning outputs:

| Planning artifact | Steering phase |
| --- | --- |
| Product | `product` |
| Requirements | `requirements` |
| Architecture | `architecture` |
| Program Design | `program-design` |
| Slice Plan | `slice-planning` |
| Tasks | `task-planning` |

The subject union also reserves typed bindings for implementation attempts,
verification evidence, and review operations. Runtime attachment is deferred.
A stale planning dependency can become an explicit seed for the existing
planning-lineage propagation rules; 05C-3A does not add a second propagation
engine.

Two dependency modes exist:

- `whole-snapshot`: the subject consumed the complete semantic payload;
- `declared`: the subject consumed a nonempty, verified set of exact resource
  revisions, semantic keys, exact contributing rules, and/or typed enforcement
  bindings.

Declared observations must exist in the bound snapshot and overlap an optional
relevance scope. Empty or prose-inferred fine-grained dependencies fail closed.

## Steering change observations

`aira.dev/steering-change-set/v1` represents a complete comparison between two
exact semantic snapshot references. It is not a filesystem diff. Pure comparison
classifies:

- resource addition, removal, and exact revision change;
- semantic rule addition, removal, and value/effect change;
- authority, resolved scope, inclusion, enforcement, and provenance change;
- resolver-policy change.

Change observations carry exact old/new resource and effective-rule state,
including revisions, contributors, regions, and typed bindings. Filenames and
materialization paths are not comparison identities.

## Causal staleness

`evaluateSteeringStaleness` returns `still-applicable`, `stale`,
`requires-reanalysis`, or `invalid-input`, plus stable structured reasons.

Whole-snapshot dependencies observe every semantic payload change. Audit-only
changes remain equivalent. Resolver-policy changes require reanalysis because no
future policy is assumed compatible.

Declared dependencies are causal:

- an unrelated semantic-key change remains applicable;
- a depended semantic value change or removal is stale;
- an exact resource revision change is stale for an exact-resource dependency;
- an exact authored-rule source revision change is stale for an exact-rule
  dependency;
- authority, applicability scope, and relevant inclusion changes require
  reanalysis;
- required enforcement disappearance or substitution is stale;
- enforcement strengthening requires reanalysis and later reverification;
- contributor churn with identical effective semantics remains applicable for a
  semantic-key-only dependency, while exact resource/rule dependencies still
  observe their exact source changes.

The reason-code vocabulary includes repository-convention equivalents of
`STEERING_DEPENDENCY_RESOURCE_CHANGED`, `RULE_CHANGED`, `RULE_REMOVED`,
`AUTHORITY_CHANGED`, `SCOPE_CHANGED`, `ENFORCEMENT_CHANGED`,
`REQUIRED_INPUT_MISSING`, `RESOLUTION_POLICY_CHANGED`, `UNRELATED_CHANGE`, and
`EQUIVALENT`.

Missing snapshots, mismatched comparison origins, absent declared observations,
incomplete comparisons, and unknown policy compatibility fail conservatively.
Aira never guesses equivalence from headings, titles, filenames, or prose.

## Why one edit does not invalidate every Spec

INV-STEER-012 requires causal invalidation. A project can change an operations
rule without changing Product inputs, or change a path-scoped API rule without
affecting work outside that scope. Whole-snapshot dependencies remain available
when precise relevance is not known, but fine-grained dependencies let the domain
prove that an unrelated semantic change does not affect a downstream subject.

This preserves history and avoids the forbidden shortcut that any Steering edit
invalidates every Spec.

## Deferred

05C-3B1 and 05C-3B2 now own Steering resource and snapshot publication,
BlobStore integration, registry authority, transactional CAS, durability,
retention, and load-time integrity. 05C-4 owns filesystem discovery/materialization,
template adoption operations, logical path observation, and `AGENTS.md`
interoperability. 05C-5 owns broader adversarial and integration auditing.
Context delivery, worker/runtime attachment, capability compilation, verifier
execution, scheduling, and CLI/Pi UX also remain deferred.
