# Stage-5 adversarial review of stage-4 storage

Status: review completed against ADRs 001-011, invariants, domain/storage contracts,
all `src/storage/` implementations and every stage-4 storage test. The initial full
suite was independently reproduced: 1380 passing tests. Tests were treated as evidence,
not specifications. No worker/frontend integration was used for the review.

## Review matrix

| Area | Review result / evidence |
| --- | --- |
| Canonical serialization | Exact UTF-16 key ordering, UTF-8, finite-number rules, negative-zero rejection, unsupported object/array forms and canonical decode round-trip retained. Additional canonical null/array/object impostors are rejected by typed HEAD decoding. Canonical JSON alone is not a domain validator. |
| Blob publication | Exclusive complete fsynced temporary inode followed by exclusive hard link is retained. Concurrent identical puts, exact-byte snapshots, collisions and corrupt blobs are tested. Reads verify hashes, not filenames. |
| Commit identity | Payload hashing excludes envelope ID; entire canonical intent fingerprints OperationId. Rehashed adversarial commits still undergo relationships/closure checks. Valid blob hashes cannot stand in for another record contract. |
| HEAD authority | HEAD remains sole publication point. A newer valid orphan never replaces a corrupt current commit. Added explicit paired regression for that case. |
| Idempotency / CAS | Reachable operation history is checked before stale CAS; input changes under an existing OperationId fail. Deep duplicate operations are now tested behind multiple unique descendants. No mutable index or timestamp authority. |
| Generations | Decimal u64 schemas and checked successors prevent overflow; Spec and per-run generations remain distinct. Audit-only changes cannot mutate domain state. A changed run was able to rebind approved inputs under the same ID: fixed. |
| Lock creation | Atomic mkdir is retained. Invalid lock identity used to reach FORMAT initialization before validation: now validated first. Owner metadata is validated before creation; the created directory inode is checked after owner publication. |
| Lock ownership | A token alone accepted same-token directory/owner-file substitution and complete-metadata changes. Handles now pin directory inode, owner-file inode and exact metadata. The last pre-HEAD-rename boundary rechecks ownership after temporary I/O/failpoints. |
| Stale recovery / PID reuse | ESRCH in the same hostname/boot/PID-namespace scope remains mandatory. Any live/reused PID stays busy. No TTL, age or timestamp repair. Recovery rechecks complete ancestor identities, not merely tokens, and rejects tombstone collisions. Ownerless/corrupt/foreign or interrupted unknown cleaners remain manual work. |
| Fsync boundaries | Required immutable entries and ancestor directories remain synced before commit/HEAD. HEAD temporary fsync precedes rename; containing directory fsync precedes durable acknowledgment. Release/recovery directory changes remain synced. Added target-inode validation to file sync opens. |
| Temporaries | Same-directory exclusive temporaries, collision handling, crash leftovers and orphan classification retained. No cleanup masquerades as authority. |
| Symlinks / TOCTOU | Existing no-follow opens/ancestor checks retained. File reads now recheck path identity and content-change metadata after reading; sync opens verify the opened inode. Lock and nested blob-prefix substitution tests added. Not a race-free openat implementation. |
| Filesystem capability detection | Project-only statfs could miss a nested control-storage mount. Existing destination ancestors are now independently checked before mutation. Incomplete capability probe results no longer pass vacuously. Platform claims were too broad: mutation now explicitly requires Linux, regardless of a supplied primitive probe. |
| Format / layout | Strict FORMAT schema extracted into a provider-neutral module without changing bytes. Conflicting root FORMAT, sibling state-version roots and unknown v2 namespaces fail mutation closed. Inspection dispatch reports independent subsystem results; storage inventory stops before current layout/record decoding under unsupported FORMAT. |
| Path encoding | Central validation and reversible hex-UTF8 keys remain injective; invalid IDs/hashes cannot form storage paths. No current state is inferred from directory enumeration. |
| History verification | Pinned HEAD traversal checks hashes, sequences, expectations, operation uniqueness, generations, immutable named records and required blobs. Current/full reads intentionally do not deep-verify all old content; explicit deep verification does. |
| Cross-record integrity | Existence-only attempt/evidence checks and unchecked claim snapshots could accept unrelated valid records. Added owning-run/attempt/task/verifier/snapshot/fence reference checks. These are referential integrity, not lifecycle authorization or scheduling decisions. |
| Orphan inspection | Higher sequence/time is non-authoritative. Corrupt/racing roots make unproven orphans unknown. Inventory remains observational, never GC authorization. |
| Crash failpoints | All nine stage-4 boundaries still run injected-I/O and real-process SIGKILL genesis/mutation tests. Added a lock substitution at the final pre-rename barrier. No production corruption switches. |
| Cross-process tests | Existing independent-process same-Spec CAS, identical/different OperationId, independent Spec locks and competing cleaner tests retained. No implementation worker is connected by these storage subprocess tests. |
| Behavioral pins | Exact metadata/content closure, bundles, compatibility environment and no-default-fallback behavior retained. Storage checks attribution, not publisher authentication. |
| Error taxonomy | Stable codes retained. Future-schema-looking opaque custom JSON could incorrectly turn an unrelated malformed record into unsupported-schema: error classification now skips explicit opaque maps. |
| Derived/materialized data | No derived view is loaded as authority. Query enumeration reports HEAD-less Spec directories instead of inventing Specs. |

## Tests that reflected implementation rather than the contract

The old ancient-lock-time test deliberately rewrote owner metadata and then expected
release to succeed because its token remained unchanged. That expectation encoded the
implementation's token-only check, not exclusive ownership of the original lock.
It now expects `STORE_LOCK_OWNERSHIP`; the live-PID recovery assertions are unchanged.
New tests preserve a token while replacing a directory, owner file or metadata to make
this distinction explicit.

The preexisting domain boundary test classified every non-domain/non-storage file as
v1 runtime. It now explicitly recognizes the new compatibility/migration composition
layers above the domains, while retaining all old purity assertions and additionally
forbidding v1 runtime from importing those layers. Frozen legacy/v1 is deliberately
not exempted. Separate tests enforce its isolated decoder dependencies and migration's
filesystem-free runtime import closure.

Fixture helpers compute real hashes with the implementation codec for convenient valid
state construction. That cannot by itself independently prove encoding correctness.
The suite retains literal canonical byte expectations and adds independently malformed
canonical values, wrong record kinds, rehashed cross-record defects, deep duplicate
operations and a valid higher-sequence orphan alongside corrupt current authority.
Existing symbolic pure-domain codec tests are still explicitly codec-only, not evidence
that symbolic hashes represent real historical content.

During hardening, an initial post-read ctime comparison rejected valid concurrent blob
hard-link publication (link count changes update ctime without changing bytes). The
existing concurrent immutable-put regression exposed this immediately. V2 reads compare
inode, size and mtime and still verify the actual digest; ctime is not used as byte
identity. This preserves legal link publication without weakening integrity.

## Package and platform review

`git show 4e3712d -- package.json` shows exactly two stage-4 additions: explicit
`./storage` and `./storage/file` exports. No dependency, bin, script, package version,
root/core/agent/Pi export or Pi extension/skill registration changed. Stage 5 does not
modify package.json, lockfile, runtime entrypoints or existing v1 files.

Mutation is supported only on Linux with required no-follow, exclusive-creation/link,
atomic replacement and file/directory fsync primitives. Tests use persistent local
Btrfs on this host, not volatile tmpfs. Known volatile/network/FUSE types are rejected
at each existing destination ancestor. Primitive support does not certify an unknown
filesystem, remote wrapper, controller, syncing service or mount arrangement. There is
no Windows/macOS mutation guarantee and no test-only override that enables those OSes.
Read-only legacy inspection is separately tested on Linux; broader portability remains
unverified.

## Residual limitations / required future work

- Node pathname APIs still cannot provide race-free directory-descriptor confinement.
  Untrusted workers must never have control-root write access. Inode rechecks reduce,
  but do not eliminate, malicious substitution windows.
- Read observations do not freeze concurrent v1 writes. A future import executor must
  capture exact source buffers, reject changed observations and never import new bytes
  under a reviewed old plan. No import executor is present in this stage.
- Ownerless or unverifiable lock/cleaner records may require offline operator inspection.
  Permission ambiguity, PID reuse and foreign process scopes intentionally cause false
  busy rather than unsafe recovery.
- Real SIGKILL tests prove process-crash behavior, not disk/controller power-loss safety.
  Filesystem fsync guarantees remain a deployment prerequisite.
- Coherent malicious rollback/replacement of a whole valid store by its trusted owner
  is not detectable without external checkpoints/signatures. Hashes are not authentication.
- Default full loading checks current closure and the immediate parent, not every old
  blob; deep verification remains explicit. Operation lookup/commit history traversal
  is O(history); blobs and records are buffered, not streamed.
- Inspection inventories are pinned observations, not authorization for GC or orphan
  adoption. There is no automatic repair, GC, global asset publisher authentication,
  archive persistence, sandbox, workspace capture or external-effect exactly-once claim.

No ADR or invariant was weakened. See the
[compatibility/migration contract](compatibility-migration-contract.md) for the separate
pure archive proposal/port and why it is not persisted through a fake Spec.
