# Steering 05C-3B2: immutable snapshot persistence and storage audit

Status: implemented. This document extends the
[Project Steering contract](steering-contract.md), the pure
[snapshot contract](steering-snapshot-05c3a.md), and the authoritative
[registry store contract](steering-store-05c3b1.md). It does not add Steering
source discovery or authoring adapters.

## Separate persistence authority

A persisted `SteeringSnapshot` is immutable historical evidence of one exact
successful resolution. Snapshot publication does not run the resolver and does
not mutate project Steering. It does not publish a Steering commit, replace
Steering HEAD, advance `CommitSequence`, or advance `SteeringGeneration`.

The provider-neutral `SteeringSnapshotStore` is separate from `SteeringStore`.
It provides `putSnapshot`, `getSnapshot`, `hasSnapshot`, `inspectSnapshot`, and
`verifySnapshot`. `getSnapshot` returns the exact embedded domain snapshot.
`inspectSnapshot` additionally exposes its persisted attribution record.
`verifySnapshot` performs the explicit deep closure and historical authority
check.

## Persisted record

The strict persisted schemas are:

- `aira.dev/steering-snapshot-record/v1`
- `aira.dev/steering-snapshot-locator/v1`

The snapshot record contains the complete `aira.dev/steering-snapshot/v1`
value, its `SteeringSnapshotId`, its domain semantic hash, exact source registry
attribution, and exact publication provenance. It does not reduce the snapshot
to storage-specific summary fields. The embedded snapshot therefore retains the
resolver contract and policy, project identity, selectors, complete resource
revisions and body descriptors, effective rule provenance, enforcement
references, decisions, omissions, diagnostics, and construction audit metadata.

The domain snapshot identity remains authoritative:

```text
canonical SteeringSnapshot.semantic bytes
  -> semantic SHA-256
  -> SteeringSnapshotId
```

The record has a separate SHA-256 identity over its complete canonical record
bytes. That record hash is storage integrity metadata. It is not another logical
snapshot identity.

## Content-addressed publication and lookup

Canonical snapshot-record bytes are stored in the shared BlobStore. Snapshot
lookup uses one deterministic immutable locator:

```text
.aira/state/v2/steering/
  snapshot-locators/<full-64-hex-snapshot-token>.json
```

The locator is not a mutable snapshot file or floating current alias. Its
filename is derived from the full semantic digest in the
`SteeringSnapshotId`. Its strict body repeats the exact snapshot ID and semantic
hash and references one exact content-addressed record hash, byte count,
encoding, media type, and project. Publication uses the certified immutable
exclusive-link protocol. An existing locator is verified and never overwritten.

This is the smallest mapping needed because the domain semantic hash cannot also
be the hash of a record that contains non-semantic construction and publication
audit data. A locator cannot map snapshot A to semantically different record B:
the requested ID, semantic hash, embedded snapshot identity, canonical bytes,
and record hash must all agree.

## Source registry attribution

Every persisted record names the exact observed Steering HEAD:

- project identity;
- source commit ID;
- `CommitSequence`;
- `SteeringGeneration`;
- exact snapshot resource revision references.

Publication traverses only the commit chain reachable from authoritative current
Steering HEAD. The claimed source commit must be reachable and its reconstructed
HEAD must exactly equal the attribution. Each included resource must have been
active and current at that exact source commit, and its complete immutable
revision record and raw body must match the snapshot.

Current HEAD equality is not required. A snapshot built from an earlier valid
commit can be published after later Steering mutations because the earlier
commit remains reachable. An orphan commit, a commit from another project, a
noncurrent or retired revision claim, malformed generation metadata, a missing
historical record, or corrupt history fails closed.

The record remains independently interpretable after current Steering changes.
Ordinary historical reads do not substitute a newer revision and do not need
current HEAD to rewrite snapshot meaning.

## Read and deep verification

Every ordinary lookup checks:

1. exact persisted snapshot ID grammar and deterministic locator path;
2. no symlink or unsafe path substitution;
3. strict supported locator schema and canonical bytes;
4. exact record hash and byte count through BlobStore;
5. strict supported record and embedded snapshot schemas;
6. complete pure-domain snapshot validation;
7. semantic hash and `SteeringSnapshotId` derivation;
8. source project and exact resource-attribution consistency;
9. structured rule provenance and enforcement-reference integrity.

It does not rerun resolution, consult current files, repair records, migrate an
unknown version, clean temporary data, or mutate audit metadata.

`verifySnapshot` additionally checks the reachable historical source commit,
complete source registry closure, every canonical resource revision record, and
every exact raw body hash and byte count. This keeps ordinary lookup independent
of O(history) traversal while providing an explicit deep integrity operation.

## Deduplication and collision behavior

Publishing an identical snapshot record repeatedly is idempotent. Existing
record and locator bytes are verified and reused. Cross-process identical
publication converges through BlobStore and immutable locator publication.

The same `SteeringSnapshotId` with different semantic identity is invalid under
the domain hash contract. The same ID and semantic hash with different complete
record bytes, including different audit or publication provenance, is an
integrity collision after a locator exists. Alternate versions are never
created under one ID.

A crash after record-blob publication but before locator publication can leave
an unreachable valid record blob. No lookup returns it. Retry verifies and
reuses it. A crash after locator publication leaves a complete valid snapshot.
Retry converges on that record. Snapshot publication has no mutable transaction
journal and no Steering HEAD step because its only visible mapping is immutable.

## Retention

Snapshot locators and record blobs are retained immutable data. Historical
snapshots remain readable after registry evolution. Planning artifacts,
attempts, evidence, review operations, and future durable records can safely pin
the exact snapshot ID and semantic hash.

No garbage collector is implemented. Reads never remove an orphan or temporary.
Future deletion requires a separately designed reachability and reader
coordination policy that proves no durable record references the snapshot.
Storage inspection is observation only and is not GC authorization.

## Lock interaction and concurrency

The Steering registry lock protects only authoritative registry publication.
Snapshot construction and resolution happen outside storage locks. Immutable
snapshot publication does not acquire the Steering registry lock, a Spec lock,
or another authority lock. It uses only concurrency-safe BlobStore publication
and immutable locator publication. There is therefore no registry/snapshot/Spec
lock order and no nested authority-lock cycle.

A registry mutation can commit while a snapshot attributed to an older reachable
state is being published. The snapshot keeps the older exact source HEAD. Spec
locks remain independent, and the existing BlobStore publication protocol is
shared unchanged.

## Registry crash and idempotency audit

05C-3B2 extends the existing failpoint and real-process SIGKILL tests. Genesis
and mutation are exercised after lock acquisition, body publication,
revision-record publication, complete blob closure, commit publication, HEAD
temporary write and fsync, immediately before and after HEAD rename, after the
containing-directory fsync, and before lock release.

A fresh store observes either the previous complete authority or the new
complete authority. HEAD alone selects authority. Orphan commits do not reserve
`OperationId`, affect generation, or become current. A retry after HEAD
publication finds the reachable operation even after later commits. Concurrent
identical intent converges; concurrent different intent under one `OperationId`
fails with operation reuse.

Only authoritative semantic registry mutations advance `SteeringGeneration`.
Genesis remains zero, audit-only commits preserve it, failed CAS and pre-HEAD
crashes do not advance it, and post-HEAD replay does not advance it again.

## Inspection and integrity model

Storage inspection recognizes reachable and orphan Steering commits, Steering
publication temporaries, immutable snapshot locators, attributed snapshot record
blobs, and corrupt snapshot records. A shared BlobStore object is labeled as a
snapshot record only when a strict locator supplies that provenance. Other blobs
remain generic because the shared store serves multiple subsystems.

Unknown snapshot record or locator versions fail closed when that snapshot is
read. They do not change the frozen v1 format or cause unrelated Spec and legacy
records to be decoded under a new schema. `FORMAT` bytes remain unchanged.

## Platform and limitations

Authoritative Steering registry mutation retains the certified Linux-only local
filesystem boundary. Snapshot publication uses the same file provider and
BlobStore durability checks, so this implementation does not broaden platform
support claims merely because its records are immutable.

The existing filesystem threat model still applies. No signature or external
checkpoint detects coherent replacement or rollback by the control-root owner.
Node pathname operations do not provide race-free `openat` confinement against
an attacker that can concurrently replace trusted directories. The control root
must remain unavailable to untrusted workers.

05C-3B2 does not implement `.aira/steering/**` discovery, materialization,
`AGENTS.md`, planning staleness mutation, Context delivery, worker integration,
enforcement execution, CLI behavior, built-in Steering content, or GC.
