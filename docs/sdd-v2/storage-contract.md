# SDD v2 file persistence contract

Status: implemented in stage 4, adversarially hardened in stage 5. Stage 05B extends
only domain dispatch/reference validation for the [planning model](planning-model.md).
Affected domain schemas advance versions; old generic-design state fails closed as
specified in [ADR-012](adr/012-canonical-planning-ontology.md). No storage protocol or
FORMAT change is introduced. See the
[stage-5 audit](storage-audit-stage5.md) and separate
[compatibility/migration contract](compatibility-migration-contract.md). This specifies the concrete encoding, layout and
publication protocol selected under ADR-002/003. It does not supersede lifecycle,
behavioral-asset, execution, capability, evidence or v1 compatibility invariants.
The pure [domain contract](domain-contract.md) remains the structured data model.

## Authority and boundaries

```text
immutable exact bytes and typed records -> immutable commit -> atomic HEAD
```

One Spec's HEAD is its sole authoritative mutation publication point. Its selected
commit contains the complete domain Spec, a set of complete domain execution runs,
and exact references to immutable domain records and raw blobs. No independently
updated approval, task, run, event or view file participates in authority.

`src/storage/` defines provider-neutral ports, strict envelopes, domain record
version dispatch, errors and storage CAS/generation rules. `src/storage/file/`
implements those contracts using standard filesystem/crypto primitives. Neither
imports CLI, Pi, recipe execution or frontend code. Domain modules do not import
storage. Package subpaths `aira/storage` and `aira/storage/file` are explicit;
`src/index.ts` and all v1 runtime entrypoints are unchanged.

The constructor receives an existing explicit **project/control root**, never a
worker's execution workspace. No Spec/task/run identity incorporates that root's
absolute path. Future worktrees/containers can execute elsewhere. Hard worker denial
of access to control storage is still a required later execution-backend obligation.

## Versioned layout

```text
<project>/.aira/state/v2/
  FORMAT
  blobs/sha256/<first-two-hex>/<full-64-hex>
  specs/s-<hex-UTF8-SpecId>/
    HEAD
    commits/<full-64-hex>.json
    .head-tmp-<random-token>          # possible interrupted publication
    derived/                        # reserved, no views implemented
  locks/specs/
    s-<hex-UTF8-SpecId>.lock/
      owner.json
      recovery/owner.json           # only during explicit stale recovery
    .stale-lock-<random-token>/       # retained owner/cleaner diagnostics
    .released-lock-<random-token>/    # possible interrupted release
```

Immutable publication temporaries use `.publish-tmp-<random-token>` beside their
final target, including during FORMAT initialization. Tokens are random 192-bit hex
by default and exclusive creation remains mandatory even if tokens collide.

`FORMAT` is an immutable exact record with schema `aira.dev/file-store/v1`, store
`v2`, canonical encoding `aira.dev/canonical-json/v1`, SHA-256, reversible hex-UTF8
Spec keys, and the immutable-link/atomic-HEAD publication strategy. Missing or
unsupported FORMAT on existing state is an error, never permission to migrate.
An interrupted first initializer may leave only recognizable temporaries before
FORMAT exists. Creation never infers Spec existence from directories or commits.
A strict provider-neutral FORMAT schema freezes these exact fields. Conflicting
control-root FORMAT, sibling state-version roots and unknown v2 namespaces fail
mutation closed rather than silently choosing the most convenient marker.

Spec keys are centrally validated and injectively encoded, not raw user strings.
The encoding is reversible and case-insensitive-filesystem safe. Digest paths accept
only the domain's lowercase `sha256:<64 hex>` identity. Filesystem enumeration is
never a source of current sequence or state.

## Canonical bytes and structured records

Canonical JSON v1 uses deterministic lexicographic UTF-16 object-key ordering,
ECMAScript finite-number rendering, exact JSON strings, ordered arrays, UTF-8 and no
BOM or insignificant whitespace. It does not normalize Unicode or feedback whitespace.
Lone UTF-16 surrogates remain JSON escapes and round-trip without replacement.
Negative zero is rejected rather than silently changing its identity to zero.

Undefined, nonfinite numbers, bigint, functions, symbols, dates/classes, accessors,
non-enumerable properties, symbol keys, sparse/decorated arrays and cycles are rejected.
Supported domain integers still undergo strict safe-integer/u64 schema validation.
Canonical serialization does not validate domain semantics. Decoding requires valid
UTF-8, canonical bytes, explicit supported schemas, and stable decode/encode equality;
duplicate JSON keys, extra keys and noncanonical alternative encodings fail closed.
Explicit domain custom JSON maps are opaque data, not additional schema/reference
lookup sites merely because they contain keys named `schema`, `id` or `hash`.

The record registry dispatches explicit supported strict domain schemas rather than copying
selected fields into a reduced storage model. Product, Requirements, Architecture,
Program Design, Slice Plans and state, DAG tasks,
analyses/findings, lineage, human decisions, revision feedback/resolution, policies,
context snapshots, attempts, evidence, workspaces, behavioral assets/bundles/profiles
and transaction-precondition records retain their full contracts. Spec and execution
run aggregates reside directly in the state envelope; the record catalog references
other domain documents by `{contract, hash}`. Named immutable records cannot be
removed or rebound in the Spec history. Revision requests retain their initial
feedback/provenance and may make their domain-defined first terminal transition;
previous committed snapshots preserve the original pending record.

A structured **record reference hash** covers its complete canonical domain envelope.
For an identity-bearing structured body, the attached `identity` (or kind/mode
profile `asset`) is outside the body hash. Raw behavioral-asset body hashes identify
unnormalized bytes, not the metadata revision envelope. Artifact content hashes
identify the complete canonical content document, which does not self-hash.
Artifact subject `lineage_hash` covers `{created, lineage, behavioral_profile?}`;
validation/applicability records never enter that immutable authoring-provenance hash.
Nested task/verifier definition bodies likewise exclude their identity envelope.
These are distinct hash subjects, all using the single existing SHA-256 representation.

## Stage-05B planning integrity

All six artifact kinds have distinct content schemas. `planningContentContracts` maps
artifact kinds to exact supported schema identifiers rather than constructing a `/v1`
identifier by convention. The store checks the canonical typed body hash/size and full
reference closure, including exact provenance-bound R/AC/A/PD/S inputs, reciprocal Task
ownership, separate Slice DAG ordering, semantic finding targets and current identity
registry/tombstones. Scope observations are measured from exact `planningEntities` hash
subjects, never trusted asserted entity digests. Slice states bind their run's exact
Slice Plan snapshot; selected Slice evidence must belong to that run/Slice/verifier.
Lifecycle approval/readiness decisions still belong to the pure domain/Core, not storage.

Old `aira.dev/design/v1` and affected old enclosing domain schemas are not decoded as
current canonical state. There is no compatibility decoder/converter for pre-release
v2 development stores. Their bytes/HEAD are not rewritten. Frozen v1 and its explicit
migration contracts are separate and unaffected. Blob/commit/HEAD encodings, ownership,
CAS, generations, fsync barriers and crash recovery below are unchanged.

## BlobStore

`put(bytes)`, `get(hash)`, `exists(hash)` and `verify(hash)` operate on exact immutable
uncompressed bytes. Put snapshots caller memory before yielding. The same generic
store holds domain record envelopes, canonical artifact bodies, behavioral content,
context content, command outputs and large audit/evidence payloads. There are no
subsystem-specific blob namespaces or implicit Markdown assumptions.

Publication writes a same-directory exclusive temporary file, fsyncs the complete
file, then uses an **exclusive hard link** to install the final identity. This is
stronger than opening the final name with `wx` and filling it: a killed writer cannot
leave a partially written final identity. The parent directory is fsynced, the
writer's temporary is unlinked, and the directory is fsynced again. A pre-existing
identity must contain exactly the expected bytes; it is verified and synced rather
than overwritten. Get/exists verify the digest; corruption is not reported as absence.

No streaming/compression/GC is implemented. Byte identity permits future streaming
without redefining hashes. Raw bytes and outputs need not be embedded in large commit
JSON. The current API buffers bytes in memory; callers should account for that cost.

## Commit, HEAD and audit

The commit envelope is `aira.dev/store-commit/v1` with `{id, payload}`. Its versioned
payload includes Spec ID, positive CommitSequence, parent/null, audit timestamp,
resulting Spec generation, per-run generations and current-run projection,
canonical operation fingerprint, and the complete strict transaction intent.

The intent carries OperationId, actor/channel, mutation scope/reason, expected HEAD
and domain conditions, resulting state, and structured audit events with changed
identities and optional blob payload references. The immutable expected/resulting
states also allow generation and authoritative-identity changes to be reconstructed.
No separate mutable journal or operation index is authoritative.

`id = SHA256(canonical(payload))`; the envelope's own ID is not hashed into itself.
The filename is only a locator. Readers check the envelope, recompute both commit and
operation hashes, and verify the Spec, sequence, parent and generation relationships.

HEAD is `aira.dev/store-head/v1`: Spec ID, commit ID, sequence, SpecGeneration,
`run_id`/`run_generation` projection and the sorted per-run generation vector.
It is a regular canonical file, not a symlink. Its integrity is established by strict
schema validation and exact agreement with the cryptographically checked commit.

## Transactions, counters and idempotency

`SpecStore` exposes createSpec, commit, loadSpec, inspectHead, history,
findCommittedOperation and verifySpecHistory. Callers never manipulate paths.
Creation requires `expected: null` and absence of authoritative HEAD. Every other
transaction requires the complete expected HEAD, current artifact subjects, and an
explicit execution-expectation list (possibly empty). Execution expectations support
exact run/task definition, task state, attempt, claim and fence/owner/epoch checks.
All expectations are tested under cross-process ownership. There is no blind save.

Creation establishes sequence **1**, SpecGeneration **0**, and no execution runs.
Subsequent sequence is exactly parent + 1, using the existing checked decimal-u64
strategy. Zero, fractional, unsafe/overflowing or noncanonical counters cannot be
published as a commit sequence.

SpecGeneration advances exactly once for declared semantic mutations, not run-only
bookkeeping. RunGeneration is **per execution run**, as required by ADR-003. A newly
introduced run starts at zero; an existing changed run advances exactly once. Other
runs are unchanged and prior run IDs cannot be erased/reassigned. The complete vector
prevents ABA when a new run starts. The singular HEAD RunGeneration projects the
currently bound run (zero with no binding); switching run identity is not a decrease
of the previous run's counter. Historical per-run counters never decrease.

Audit-only transactions advance only CommitSequence and cannot change domain state.
Combined transactions declare both scopes. Core, not storage, computes lifecycle,
approval, completion, applicability and scheduling decisions. Once Core declares an
active run binding superseded, revocation of its active claims/authorities must be
in the same state publication. No scheduler or worker has been connected.

Domain `commit_sequence` fields are preserved rather than silently rewritten. They
must not point into the future; a mutated/new run records its publication sequence.
The returned HEAD is always the current storage CAS token. Spec's optional sequence
is not substituted for HEAD. Human review remains bound to its domain Spec generation;
Core can reload a newer run-only HEAD and reprepare storage CAS without inventing a
new review decision.

The canonical **entire intent**, including preconditions, state, audit and actor,
binds OperationId. Array order remains significant. Transport bytes are checked
against their hashes and are not duplicated inside the operation fingerprint.
Matching retries find the reachable committed operation before evaluating stale CAS
and return its original snapshot/identities with `replayed: true`, even after later
commits. Different intent is `STORE_OPERATION_REUSE`. Unreachable operations do not
count. Lost acknowledgement after HEAD publication is resolved by history lookup and
renewed sync before acknowledging replay, never by rerunning an external effect.

Results contain Spec ID, commit ID, sequence, both generation scopes, OperationId,
replay status, complete state and decoded referenced domain metadata. No mutable
operation index or last-writer-wins fallback exists.

## Cross-process ownership and stale recovery

Per-Spec atomic directory creation is the writer primitive. Independent Specs have
independent locks; there is no global mutation lock. Owner metadata has its own strict
version, random token, PID, hostname, UTC acquisition time and process-table scope.
Linux scope includes boot identity and PID namespace, avoiding unsafe ESRCH inference
across containers sharing a hostname but not a process table. Missing/foreign scope,
PID reuse, permission ambiguity and any demonstrably live PID remain busy.

Acquisition waits a bounded monotonic-clock interval (default five seconds). It never
implicitly steals locks. `FileSpecStore.recoverLock(specId)` is explicit. Ordinary
loads, history, verification and inspection do not recover anything.

Recovery requires a same-scope local PID demonstrably dead via ESRCH. A unique
exclusive `recovery/` directory serializes cleaners inside the dead owner directory.
A fully identified dead cleaner may be fenced by another nested cleaner, with every
ancestor identity/death rechecked before quarantine. Live or ownerless cleaners are
not stolen. After 32 interrupted-cleaner levels, recovery is conservative busy.
Recovery atomically renames the old directory to a unique stale diagnostic tombstone;
a fresh acquisition must still win its own atomic mkdir.

Ownership handles pin the created directory inode, owner-file inode and complete
canonical owner metadata, not just its token. Acquisition validates identities before
filesystem initialization. Recovery rechecks those complete identities for every
ancestor; replacing metadata while retaining a token is not continued ownership.
The writer rechecks ownership after HEAD temporary I/O, immediately before rename.

Release checks the pinned identity, token and expected lock contents, renames the owned directory out
of the public lock name, fsyncs the parent, then removes its own release tombstone.
A release crash does not leave an intentionally ownerless public lock. No process
may release a different token. Diagnostic locks are not Spec state or a lease clock.

An ownerless creation/cleaner, corrupted metadata, changed hostname/boot/namespace,
or unprovable process table can require offline operator inspection. Do not delete
such locks while another writer could be alive. There is no automatic age/TTL repair.
Locks cover short storage publication only: never LLMs, shell commands, human waits,
verifier execution or other external work. Failpoint barriers are test-only exceptions.

## Durability, crashes and recovery

Under ownership: reload/verify HEAD, check idempotency and CAS, validate the proposed
contracts, publish/sync required blobs, publish/sync the immutable commit, prepare an
exclusive same-directory HEAD temporary, fsync it, rename over HEAD without deleting
HEAD, fsync its directory, then release ownership. Required existing blob entries and
ancestor directories are also synced before making them reachable, covering retries
of interrupted immutable publication and interrupted directory initialization.

Before HEAD rename, old HEAD (or absence at genesis) wins. After rename, new HEAD wins
for process-crash recovery, even if the caller did not receive success. Failure before
final directory fsync is not acknowledged as durable success. Following OS/power loss
before that barrier, supported filesystem primitives may retain the previous or new
HEAD, with only complete durable referenced records eligible for publication. Tests
exercise real process death but cannot prove disk/controller power-loss behavior.

Internal constructor injection provides a clock, random-token source, required
filesystem capability probe and named failpoints: after lock acquisition, blobs,
commit, HEAD temporary write, HEAD temporary fsync, before/after HEAD rename, after
HEAD directory fsync, and before lock release. No production environment-variable
corruption switches exist. Fsync/I/O failures are surfaced, not downgraded to success.

Default `loadSpec(..., "full")` checks current HEAD/commit, its immediate parent
relationship, complete structured record closure, and raw required blob integrity. Run identities cannot be rebound to different
approved snapshots. Attempt/evidence/claim/task/authority references must bind their
owning run and exact task/snapshot/fence identities, not merely exist in the catalog.
`"current"` still verifies current structured records but may defer raw content/output
hashing for inspection. `"deep"` and verifySpecHistory explicitly traverse the entire
pinned HEAD chain, checking genesis, hashes, exact parent/sequence agreement, unique
operations, scoped generations, immutable named identities and required records/blobs.
History and operation lookup only traverse reachable parents. Loads do not enumerate
all blob files or all historical commits. Operation lookup currently costs O(history);
its API allows a future rebuildable index without changing authority.

`inspectStorage` classifies reachable, orphaned, temporary, corrupt and unknown records.
It never promotes a high-numbered/newest orphan, repairs HEAD, rewrites bytes or deletes
files. Corrupt/racing roots make unproven orphans unknown. Its pinned-root inventory is
an observation, **not GC authorization**; active publication/pinned readers still need
future GC coordination. Stale-lock diagnostics and publication temporaries are retained
for explicit inspection. No materialized views or garbage collector are implemented.

## Behavioral assets, context and evidence

Pins retain role, asset ID/kind, exact revision/hash, provenance, typed domain reference
and exact bundle membership. Referenced revision metadata retains compatibility and
publication provenance. The same blob layer contains exact content bytes. Missing,
ambiguous, incompatible or hash-mismatched pins fail durable use without resolving
latest/default/current-package aliases. Known typed capability/execution profile bodies
must also be supplied and match their references. Kinds/modes and snapshots validate
their explicit body hashes and the existing domain binding/resolution contracts.
Opaque profile kinds without a separate domain body schema remain exact raw bytes,
not a newly invented reduced profile schema.

The store captures an explicit compatibility environment with behavioral state. It
checks the supplied immutable closure, not installed current-package defaults. Domain
records and pins are preserved across authoring phases and runs. Schema/hash checks
are **not publisher authentication**: trusted product/project asset materialization
must later establish ownership and decode the exact published bytes. This stage does
not implement a global built-in distribution registry or ship prompt/skill content.
Named identity immutability is enforced within authoritative Spec history; global
content-hash identities are immutable across the shared blob store.

Context snapshot entries reference exact content/size (and original summary sources).
Evidence/attempt/audit outputs are blobs, not inline command transcripts in HEAD.
Workspace fingerprints, backend declarations, outcomes including unknown and recovery
contracts remain exact domain metadata; the store does not produce or authenticate
workspace observations, run verifiers, sandbox workers or reconcile external effects.
Metadata idempotency never implies exactly-once external effects (ADR-009).

## Errors and platform limitations

Stable `StorageError.code` values: STORE_NOT_FOUND, STORE_ALREADY_EXISTS,
STORE_CONFLICT, STORE_LOCKED, STORE_LOCK_OWNERSHIP, STORE_INTEGRITY,
STORE_CORRUPT_HEAD, STORE_CORRUPT_COMMIT, STORE_CORRUPT_BLOB,
STORE_SCHEMA_UNSUPPORTED, STORE_OPERATION_REUSE, STORE_PATH_UNSAFE,
STORE_DURABILITY_UNSUPPORTED and STORE_IO. Missing authoritative references are
integrity/corruption failures, not evidence that the Spec can be recreated.

The tested platform is Linux/Bun on persistent local Btrfs (`/var/tmp` on the test
host). Known tmpfs/ramfs volumes are rejected rather than acknowledged as durable
storage. The tests do not disable durability; they avoid volatile `/tmp` mounts.
Required primitives are
exclusive file/directory creation, regular-file no-follow opens, exclusive hard links,
atomic same-directory replacement, file fsync and directory fsync. Missing primitives
fail with unsupported-storage errors. Mutation is explicitly **Linux-only**, including when internal capability probes
are supplied. Windows/macOS mutation fails with STORE_DURABILITY_UNSUPPORTED rather
than attempting uncertified replacement/directory durability. The filesystem type is
checked on existing destination ancestors too, so a nested mount does not inherit a
project root's capability result. Platforms without a provable process-table scope cannot automatically
recover dead owners. Known network/FUSE filesystem types are rejected; unrecognized
network, distributed, synchronizing or wrapper storage is not certified by capability
detection.

All ancestors are lstat/realpath checked; regular files use no-follow opens and inode
checks. Symlinked control directories/files and path escapes fail closed. These checks
detect obvious substitution, but Node's pathname APIs are not race-free openat-based
confinement against an attacker concurrently replacing directories. The control root
must not be writable by untrusted workers. Cryptographic integrity is not an external
signature/checkpoint: coherent malicious replacement/rollback of an entire valid store
by its owner cannot be detected without a separate trusted authority. No distributed
consistency, sandboxing, external-effect exactly-once behavior, stronger-than-filesystem
power-loss guarantee, automatic v1 migration or v1 runtime change is claimed.
