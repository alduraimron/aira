# Steering 05C-3B1: project registry persistence

Status: implemented. This document specifies the persistence slice of the
[Project Steering contract](steering-contract.md). The pure resource,
[resolution](steering-resolution-05c2.md), and
[snapshot](steering-snapshot-05c3a.md) contracts remain normative.

05C-3B1 persists the project Steering registry, immutable resource revision
records, exact raw bodies, and their commit history. Immutable
`SteeringSnapshot` records are persisted separately by
[05C-3B2](steering-store-05c3b2.md) without mutating this registry.

## Authority and aggregate boundary

Project Steering is one project-level authoritative aggregate. It is not a
Spec, does not have a `SpecId`, and is not stored through `SpecStore`.
`SteeringStore` is a separate provider-neutral port with these operations:

- `createRegistry`
- `loadRegistry`
- `inspectHead`
- `commit`
- `history`
- `findCommittedOperation`
- `verifyHistory`

A successful load returns the exact current commit ID, `CommitSequence`,
`SteeringGeneration`, registry state, and decoded immutable resource revisions.
Callers do not manipulate storage paths.

The file provider uses this authority rule:

```text
exact body and revision-record blobs
  -> immutable Steering commit
  -> atomic Steering HEAD replacement
```

Before genesis HEAD publication, the registry does not authoritatively exist.
After HEAD publication, the complete committed registry is authoritative.
Directories, immutable blobs, temporary files, and orphan commits never create
or advance authority.

## On-disk layout

The file provider extends the existing v2 state root without changing `FORMAT`:

```text
<project>/.aira/state/v2/
  FORMAT
  blobs/sha256/<first-two-hex>/<full-64-hex>
  steering/
    HEAD
    commits/<full-64-hex>.json
    .head-tmp-<random-token>          # possible interrupted publication
  specs/                              # existing, independent Spec authority
  locks/
    steering/project.lock/
      owner.json
      recovery/owner.json             # only during explicit stale recovery
    specs/<encoded-spec-id>.lock/      # existing per-Spec locks
```

Resource IDs and project IDs are logical identities, not path components. A
resource is never placed under `specs/<fake-id>` and no filename selects a
current revision. Revision records and raw body bytes share the certified
content-addressed `BlobStore`.

## Registry contract

`aira.dev/steering-registry/v1` contains:

- exact project/control identity;
- project `SteeringGeneration`;
- canonically ordered logical resource entries;
- active or retired state;
- the exact current `SteeringRevisionReference` for each active resource;
- the retained ordered immutable revision history;
- exact canonical revision-record hash, byte count, encoding, and media type;
- exact raw body hash, byte count, media type, and raw-byte encoding;
- resource kind and optional custom kind;
- source layer and structured provenance;
- compatibility declarations;
- exact composition parent and override references;
- exact predecessor references.

Each registry revision reference resolves to one canonical
`aira.dev/steering-resource/v1` record in `BlobStore`. Loads compare the decoded
record to all commit-bound discovery metadata. Active current references must
name the last exact revision in one linear history. Retirement clears the
current reference while retaining the complete history as a tombstone. Retired
logical identities cannot be reactivated or reassigned.

The store invokes the pure Steering revision schema and publication-history
validators. Storage adds immutable-record integrity, project consistency,
reference closure, authority evolution, CAS, and durable publication checks.
It does not create a competing semantic validator.

## SteeringGeneration

`SteeringGeneration` is a canonical decimal u64 string. It is distinct from
`CommitSequence`, `SpecGeneration`, and `RunGeneration`.

Genesis establishes:

- `CommitSequence = 1`
- `SteeringGeneration = 0`

Every later commit advances `CommitSequence` exactly once. A semantic registry
mutation advances `SteeringGeneration` exactly once. Publishing a resource,
publishing a successor revision, retiring a resource, or changing represented
authoritative registry semantics is a semantic mutation. An audit-only commit
must preserve the exact registry and generation. Reads never advance either
counter.

## Commit and HEAD records

The persisted schemas are:

- `aira.dev/steering-store-transaction/v1`
- `aira.dev/steering-store-commit-payload/v1`
- `aira.dev/steering-store-commit/v1`
- `aira.dev/steering-store-head/v1`

A commit payload binds project identity, positive `CommitSequence`, exact parent,
audit time, resulting `SteeringGeneration`, operation fingerprint, and the full
transaction intent. The transaction binds `OperationId`, explicit expected
state, mutation category and affected logical resources, actor and channel,
resulting registry, and structured audit events.

The commit ID is SHA-256 over canonical commit payload bytes. The ID is outside
its own hash subject. The operation fingerprint is SHA-256 over the complete
canonical transaction. Filenames are locators only.

Steering HEAD contains schema, project identity, current commit ID,
`CommitSequence`, and `SteeringGeneration`. Readers verify exact agreement
between HEAD and the cryptographically checked commit. They never select the
highest or newest commit file.

Unknown versions fail closed. There is no migration decoder for invalid
pre-release Steering store formats.

## Revision and body publication

A publication input supplies a validated pure `SteeringResourceRevision` and
exact `Uint8Array` body bytes. No Markdown parsing, newline conversion, Unicode
normalization, trimming, or re-encoding occurs.

The store verifies:

1. the pure `aira.dev/steering-resource/v1` schema;
2. `identity.hash === content.hash`;
3. SHA-256 of exact supplied bytes equals the declared raw hash;
4. exact byte count equals the declared count;
5. canonical revision-record bytes equal the registry record reference;
6. predecessor, rule tombstone, identity, provenance, and linear-history rules;
7. composition and adoption revision references are available in the registry.

The raw body and canonical revision record are published through the existing
immutable-link `BlobStore` protocol. Existing matching blobs are verified and
reused, never overwritten.

## Transactions and CAS

Creation requires `expected: null` and authoritative HEAD absence. Every later
transaction includes the complete expected Steering HEAD, which binds commit ID,
sequence, project, and generation. It also includes an exact expectation for
every affected resource:

- absent;
- active with exact current revision reference; or
- retired.

The affected expectation set must exactly match the mutation's resource set.
There is no unconditional update API. All expectations are checked under the
project Steering writer lock. A stale HEAD, sequence, generation, resource
revision, status, or project identity fails with the existing stable storage
conflict or integrity taxonomy.

## OperationId and retries

The complete canonical transaction is the operation intent.

- Repeating an `OperationId` with the exact same intent returns the original
  committed result with `replayed: true`.
- Repeating it with different intent fails with `STORE_OPERATION_REUSE`.

Lookup traverses only the parent chain reachable from authoritative HEAD. A
retry after HEAD publication therefore discovers a committed operation even if
the original caller lost its acknowledgement. Orphan operations do not count.
There is no mutable authoritative operation index.

## Locking and durability

Steering mutation uses `locks/steering/project.lock`, separate from every
per-Spec lock. The implementation reuses the existing mkdir ownership,
owner-metadata, process-scope, inode-pinning, bounded wait, explicit dead-owner
recovery, quarantine, and ownership-checked release protocol.

The lock covers only the short publication transaction. It is not held while a
human edits, an LLM runs, analysis occurs, or approval is awaited.

Under ownership, the provider reloads HEAD, checks idempotency and CAS, validates
and publishes all required immutable blobs, fsyncs them, publishes and fsyncs the
immutable commit, writes and fsyncs a same-directory HEAD temporary, rechecks
lock ownership, atomically replaces HEAD, and fsyncs the HEAD directory. The
existing failpoints and durability capability checks are reused.

## Reads and history verification

Ordinary reads do not initialize storage, acquire writer locks, recover dead
owners, migrate, repair, clean orphans, rewrite records, or advance counters.
Default full loads verify the current registry's complete revision-record and raw
body closure. Current inspection mode still verifies canonical revision records
but may defer raw body reads. Deep mode pins HEAD and verifies the complete
reachable parent chain.

Deep verification checks:

- HEAD and commit agreement;
- commit and operation hashes;
- exact parent and sequence progression;
- stable project identity;
- exact generation evolution and no decrease;
- unique reachable `OperationId` values;
- immutable retained resource histories;
- pure revision and rule-evolution validity;
- current/retired registry consistency;
- exact revision-record references;
- required raw body and audit blobs, including hashes and byte counts.

A higher orphan commit never becomes authority.

## Difference from SpecStore

`SteeringStore` and `SpecStore` share canonical JSON, SHA-256, `BlobStore`,
immutable publication, durability helpers, safe paths, storage errors,
OperationId conventions, lock machinery, and atomic HEAD replacement.

They do not share aggregate identity or semantic counters. `SpecStore` is keyed
by `SpecId` and governs Spec/run generations. `SteeringStore` has one project
registry and governs `SteeringGeneration`. Their HEAD records, commit schemas,
transactions, histories, and locks are distinct. This prevents Steering from
becoming a fake Spec while preserving one certified transactional substrate.

## Mutable Markdown is not authority

A future authoring adapter may materialize project Markdown, but those files are
not consulted by this store. The registry's exact revision record and raw
content hash select authority. A filename, directory order, timestamp, or
mutable `current` file cannot replace HEAD and the commit-bound registry.

05C-3B1 performs no `.aira/steering/**` discovery or authoring and does not read
`AGENTS.md`.

## Deferred work

05C-3B2 implements reusable `SteeringSnapshot` record persistence, immutable
lookup, historical registry attribution, plus the broader crash and concurrency
audit for combined Steering storage. 05C-4 owns filesystem discovery,
materialization, template
adoption adapters, and `AGENTS.md` interoperability. 05C-5 owns the broader
adversarial integration audit.

Planning staleness mutation, Context resolution, worker integration, capability
runtime, verifier execution, scheduling, CLI/Pi UX, built-in content, and source
authoring remain outside this slice.
