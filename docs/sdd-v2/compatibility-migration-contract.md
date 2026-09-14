# Frozen v1 compatibility and migration contract

Status: implemented read/inspection/planning foundation, with a **pure archive port
and proposal model only**. No import executor or file-backed archive authority is
implemented. This implements ADR-008 without changing v1 runtime behavior or relaxing
any v2 lifecycle, approval, storage or provenance invariant.

## Different domains and capabilities

```text
v1 history != v2 Spec
readable != resumable != imported != convertible
```

A workflow run is historical recipe state. Its workflow name, plan files and generic
`approved` result are not Product, Requirements, System Architecture, Program Design,
Vertical Slices, Tasks or exact-bound Spec approvals. Stage 05B does not reinterpret
v1 `plan.md` or fabricate any part of the new planning ontology.
The compatibility layer never executes/resumes a v1 run, infers lineage or creates a
Spec. A future explicit user-driven conversion would create new work with new
provenance, approvals and evidence, not reinterpret this archive.

`LegacyV1RunView` and `V2SpecView` form the `HistoryItem` discriminated union. They do
not implement a common mutable domain object. Legacy items are always immutable,
non-resumable and non-convertible through this API. `importable` means eligible for
historical archive **planning**, not that an import adapter is connected. Invalid
legacy sources are inspectable diagnostics but not automatically importable.
V2 `mutable: true` describes its domain, not authorization or backend support. V2
`resumable: false` reflects the absence of runtime integration, not a lifecycle decision.

## Frozen historical decoder

`src/legacy/v1/` owns independent types, strict schema, lexical path rules, errors,
observation identities, artifact references, reader and views. The types/schema were
copied from the v1 baseline, not imported from mutable `src/run/` or `src/artifacts/`.
Runtime changes MUST NOT automatically update this decoder. Frozen fixtures remain
byte-identical and continue to test their original runtime reader as well as the new
boundary. New historical coverage must be additive and reviewed.

Historical JSON retains v1 JSON.parse semantics, including noncanonical formatting and
last-key-wins JSON decoding. Exact raw bytes are hashed before parsing. V1 did not
require canonical JSON. Unknown numeric run versions, unsupported fields, invalid
calendar dates, invalid revision checkpoints and directory-ID mismatches are rejected.
The historical schema is not tightened to require missing v2 concepts. Arbitrary step
artifact strings are decoded as historically allowed, but safe inspection may refuse
to follow them. This is a readability limitation, not a rewritten historical schema.

Every accepted run remains inspectable without its workflow, config, command files,
defaults, credentials, Pi, CLI or executor. `waiting` is not necessarily approval;
flat loop/step state is not a recovered loop tree. Resolved/pending feedback and its
exact whitespace, timestamps, attempt counts, shell result strings and generic agent
results remain as recorded. Missing earlier attempts or overwritten versions stay
unknown. Shell output is diagnostic/audit text, never v2 verification evidence.

## Exact source and observation identity

The caller supplies a stable `project_<token>` control-root association. It is an
explicit logical identity, not an absolute machine path, Git path or timestamp. This
stage does not allocate, persist or discover that identity. Relocations must reuse the
same association; unrelated projects must not share it. It is not authentication.

A versioned locator includes that project identity, relative control path, relative
run path, run-directory identity and numeric reader schema version. Its observation adds:

- original run ID from a schema-valid document, or null when undecodable; an ID
  mismatch preserves the recorded ID separately from the directory identity;
- exact observed `run.json` hash and byte count, or null if safely unreadable;
- all referenced artifact paths with sorted reference origins (current/version,
  revision predecessor and step artifact result);
- surviving artifact hashes/counts, or explicit missing/unsafe/unreadable results;
- mandatory `historical_identity: not-recorded-in-v1` / `historical_bytes: unknown`.

Source identity is SHA-256 of the observation's versioned deterministic sorted-key
JSON document. This is an observation contract, not the v2 storage/domain codec.
Inspection time is recorded separately and excluded from source/plan identity.
Directory timestamp prefixes are not used as chronology or uniqueness authority.
The original run ID plus relative locator and content observations establish identity.

Surviving bytes may have an `observed-now` digest. Archive proposals use
`observed-during-import` on exact blob references. Neither proves those bytes existed
at the historical execution/approval time. There is **no execution-time hash field**
that a reader fills using today's bytes. Missing references have no invented hash.
An archive proposal is not an imported record until a certified provider publishes it.

## Path safety and read-only I/O

All reads are relative to an explicitly supplied root. Lexical inspection rejects
traversal, absolute/drive paths, backslashes, control characters, colon and percent
encodings. Paths are never URL-decoded. Safe artifact reads must be listed by that
source and remain below its `artifacts/` directory. A historical schema-valid path that
cannot pass safe inspection is reported as unsafe, without making the remaining run
unreadable. Unreferenced session/log directory scanning is not implemented.

The file adapter lstat-checks every ancestor, refuses symlinks and multiply-linked or
nonregular files, uses no-follow/nonblocking opens where available, verifies opened
inode identity and rechecks the path and metadata after reading. run.json is rechecked
after artifact inspection. No filesystem mutation primitive or mutation lock is used.
Inspection does not create `.aira`, FORMAT, v2 directories, cache hashes, normalize
JSON, repair, migrate or delete anything.

These are pathname-based race reductions, not race-free openat confinement. A trusted,
quiescent control root is required for a coherent import capture; an adversary with
concurrent directory replacement rights can defeat portable pathname confinement.
Observations are not an atomic snapshot of all legacy files. Preflight rejects
changed observations; a future executor must capture and verify the actual transported
bytes and recheck source observations before publication. Metadata timestamps are race
diagnostics only, never content identities. Restoring identical exact bytes is not a
content change this contract can distinguish, and no historical immutability is claimed.

## Explicit project/format dispatch

`ReadLayout` is the provider-neutral read port. `detectReadFormat` examines the control
root, legacy marker types, state-version roots, strict FORMAT and namespace types.
It returns `none`, `legacy-v1`, `v2`, `mixed`, `unsupported-v2`, `corrupt-v2` or
`ambiguous`, with independent legacy/v2 statuses and stable codes. FORMAT availability
is not a claim that every Spec HEAD is valid. Query detail loads still verify authority.

The exact existing FORMAT is strictly versioned as `aira.dev/file-store/v1`. Its
current fields and canonical encoding are not inferred from optional fields. Future
versions return explicit unsupported results without invoking current state decoders.
Missing markers, alternate layouts, unsafe marker types, unknown namespaces and
conflicting version roots are not initialization or recovery instructions. The v2
mutation backend refuses conflicting control FORMAT/state namespaces. Reads never
repair an interrupted initializer; mutation may retry only the documented recognizable
initialization-temporary case.

Mixed `.aira/runs/` and `.aira/state/v2/` is intentional and valid. Legacy history
remains in place; new Specs use v2 storage. Invalid config or legacy runs do not hide
safe v2 state. Corrupt/unsupported v2 state does not hide safe legacy runs. Query
results retain per-subsystem/per-item failures rather than suppressing the other
subsystem. Unsafe shared ancestors can make both unreadable. Orphan Spec directories,
commits and materialized files are not Spec items without authoritative HEAD.

The APIs are application-neutral source boundaries. No Core/CLI/Pi or main-package
entrypoint is changed. File composition is explicitly in `src/compatibility/file.ts`.

## Pure migration inspection and plans

`inspectMigration` consumes validated reader observations, format observations and a
verified archive catalog supplied through ports. It performs no I/O. Structured finding
codes distinguish valid/corrupt/unsupported sources, artifact presence/missing/unsafe
states, unknowable historical bytes, pending/resolved revision records, unattributable
approval, interruption, unsupported continuation, importable diagnostics, existing
source conflict/already-imported and available/unavailable v2 state.

Policies explicitly select `preserve`, `archive-metadata` or `archive-surviving`, plus
`skip`/`manual` handling of invalid sources and `metadata-only`/`manual` handling of
unavailable artifacts. There is no migrate-everything boolean.

A deeply frozen, strict versioned plan binds OperationId, logical project, exact source
identities, archive HEAD CAS, explicit policy and every source's actions/warnings. Each
source starts with `preserve-source`. Other actions are `register-history`, exact
`copy-observed-blob`, `skip`, `manual` or `already-imported`. Metadata registration
includes an exact original run.json blob, not JSON reserialization. Only surviving
referenced artifact bytes may be selected for copying. Unknown/corrupt sources are
never invented as Specs or silently imported as valid runs.

Plan ID hashes its complete body. Equal observed source state, policy, operation and
archive CAS produce equal plans regardless of inspection clock or enumeration order.
Runtime immutability is enforced by deep freezing. Strict decoding verifies plan hash,
source hashes and intrinsic action references; preflight additionally rebuilds and
compares deterministic actions against freshly supplied observations/policy.

`validateMigrationPlan`, `preflightMigration` and `prepareArchivePublication` reject
changed run.json bytes (including whitespace), changed/deleted/newly surviving artifact
bytes, removed sources, changed project association and changed source validity.
Source mismatch is `MIG_STALE_PLAN`, reported as `stale-plan-rejected`. Changed archive
CAS is a separate conflict, not stale source. Newly discovered unselected runs are left
untouched; they are not silently added to a reviewed plan. A stale plan must not copy
any bytes under its old reviewed identity.

## Archive aggregate, transaction and restart contract

A proposed `aira.dev/legacy-history/v1` record has a separate `legacy_<locator-hash>`
identity, never SpecId. It contains source=v1, original run ID, complete source
observation, original run.json blob and selected surviving artifact blobs, original
recorded timestamps, explicit import timestamp, OperationId, plan ID, warnings,
limitations and `executable: false`. The record is immutable after publication.
A logical source already mapped to different observations requires manual conflict
handling. A metadata-only immutable import cannot silently acquire additional copied
artifacts through an already-imported shortcut.

`LegacyArchiveStore` specifies a separate project archive publication scope. Its
provider MUST acquire cross-process ownership, read verified reachable authority,
check exact OperationId/intent before CAS, validate complete source/record bindings,
durably publish immutable blobs/records/commit and atomically advance one archive HEAD
with directory fsync before acknowledgment. No duplicate mappings, mutable operation
index authority, orphan adoption, source writes or deletion are permitted. Required
blobs use the existing BlobStore and hash representation, not another byte store.

Pure `checkArchivePublication` enforces exact-input replay, operation-reuse rejection,
project/archive CAS and duplicate-source rejection over **verified provider inputs**.
`validateArchiveBlobs` independently checks exact transported bytes/counts, original
run ID/timestamps and artifact-reference origins. Missing/different reviewed bytes
are rejected, including when the metadata schemas themselves are valid. Report
validation also checks complete plan/source coverage, not just individual result shapes.
A persisted proposal's complete timestamp/plan/records are part of retry identity; a
retry must not regenerate an import timestamp. `prepareArchivePublication` only returns
a proposal and cannot acknowledge publication or durable success.

This stage deliberately has **no file import executor**. Stage 4 defines only Spec
keys, Spec-scoped ownership/history/CAS and a Spec HEAD layout. It supplies no archive
namespace/version negotiation, archive commit decoder, project-archive ownership key,
reachable operation history or archive recovery/inventory rules. Reusing SpecStore
would invent a Spec; using bare blob puts as imports would have no authoritative
mapping transaction. The pure aggregate/port above fixes the required semantic inputs
without inventing either unsafe persistence mechanism. A later adapter stage must
explicitly settle its versioned layout and certify that protocol, including real
cross-process and SIGKILL restart tests, before import can be enabled. No guarantee of
implemented archive persistence follows from these pure tests.

Restart reporting consumes verified committed catalog/receipt observations. Copied
blobs alone count as no import. Exact committed records can be reported imported or
already imported; missing/mismatched receipts, missing mappings and source conflicts
remain explicit failures/manual work. A retry coordinator must also reobserve sources
and reject stale plans, even when a prior import has committed. It must reuse immutable
blobs, not delete `.aira` or reset source history.

## Reports and limitations

Versioned reports distinguish imported, preserved-in-place, skipped, unsupported,
corrupt, stale-plan-rejected, already-imported, failed and manual-action-required, with
machine-readable codes and human details. Plan reports are explicitly `phase: plan`
and never fully successful execution reports. Import actions currently report
`MIG_IMPORT_ADAPTER_UNAVAILABLE`, not fake imported success. Partial or corrupt results
cannot become fully successful merely because another source was copied. Pure restart
fixtures test catalog/receipt semantics, not disk-crash safety.

No execution-capable workers, scheduler, verifier execution, sandbox, context filesystem
resolver, Spec frontend, production built-in content, materialized Spec views, automatic
conversion, Git worktrees/commits, parallel execution or GC is implemented. Legacy
inspection is tested on Linux. Its read primitives may be portable elsewhere but no
macOS/Windows safety certification is claimed. V2 mutation is explicitly Linux-only;
see the storage contract and [stage-5 audit](storage-audit-stage5.md).
