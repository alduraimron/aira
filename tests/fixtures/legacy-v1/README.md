# Frozen legacy v1 corpus

These are permanent literal, synthetic compatibility snapshots authored against the existing strict schema version 1 and v1 persistence transitions. They are not captures of real user runs, proof of old model behavior, or v2 records. No production schema was changed to author them. Do not regenerate them from current schemas, createRun/saveRun, workflow defaults, or builders in tests.

The current reader is `src/run/persistence.ts:loadRun`; artifact reads use `src/artifacts/manager.ts:readArtifact` and `readArtifactVersion`. Regression coverage is in `tests/run/legacy-v1-fixtures.test.ts`. Later reader extraction must keep these bytes and their accepted/rejected meaning, not refresh them to fit v2. See [ADR-008](../../../docs/sdd-v2/adr/008-v1-compatibility.md).

## Valid runs

All run directory names are literal stored IDs. `valid/` is passed directly as runsRoot; the tests do not create a project, regenerate workflows, execute anything, or save the runs. The whole parsed document must survive loading without default injection or discarded fields.

| Directory under valid/ | Frozen coverage |
| --- | --- |
| `20260826-100001-a1000001` | Completed run; successful multi-command shell output/exit code; skipped optional step; nested arbitrary input |
| `20260826-100002-a1000002` | Failed run; negative shell result with stdout/stderr in the persisted output string; pending later step |
| `20260826-100003-a1000003` | Cancelled run after approval cancellation; generic result=cancelled; one versioned plan remains readable |
| `20260826-100004-a1000004` | Interrupted agent attempt; attempt counter 2, no fabricated earlier attempt result; no completed_at |
| `20260826-100005-a1000005` | Waiting approval run; one versioned artifact; agent summary/artifact/output fields |
| `20260826-100006-a1000006` | Completed run with two artifact versions; resolved revision feedback pointing at v1; generic result=approved (not a v2 approval) |
| `20260826-100007-a1000007` | Running pending-revision checkpoint; resolved record followed by one latest pending record; reset target/approval states preserve attempts; both referenced versions survive |
| `20260826-100008-a1000008` | Completed agent with a nested-path non-versioned artifact; UTF-8 content; literal reduced Aira session audit JSONL |
| `20260826-100009-a1000009` | Waiting exhausted loop; loop and child states are flat entries; final failed shell and successful repair agent results, attempt counters 2 |

The two `workflows/*.yaml` files are literal synthetic explanatory fixture context for the review and loop cases, not claimed recovered historical snapshots. Tests may inspect their declarations but do not load current defaults or execute recipes. The other cases intentionally have no workflow files, showing history loading does not require them. No model/config snapshots, command prompts, or empty session/log directories are required for loadRun. The session JSONL illustrates Aira's reduced audit records, not a persisted resumable Pi session or a complete provider transcript. Shell results are in run.json, not invented log files.

## Exact v1 representations and limitations

Every requested category is representable without schema changes. The pending checkpoint is natively accepted: revisions, when present, are non-empty; at most one may be pending; it must be last and cannot have resolved_at. Resolved revisions require resolved_at. The valid pending fixture preserves an earlier resolved record and its previous-artifact reference.

V1 has no separately typed persisted loop object. The loop fixture uses the actual flat step map, current_step=repair-loop, status=waiting, and preserved final child states. Its declaration supplies illustrative structure, not extra run fields or missing iteration history. Waiting alone does not mean approval: loop exhaustion is also waiting.

V1 shell results persist success, exit_code, and the combined output string, not a structured shell-result object. Agent results persist summary, optional artifact path, and optional final output. Generic approval results have no exact actor/revision/hash binding. V1 artifacts are path-addressed and can be overwritten; a versions list is not an immutability guarantee. Non-versioned state omits versions entirely. A pending step may retain its attempt count without old result fields. Do not tighten the legacy reader to require information these snapshots lack.

## Literal rejection samples

These files are intentionally invalid or unsupported by the v1 loader. Tests read them as-is, not as runtime mutations of a generated valid run. Their error checks identify the reason rather than accepting arbitrary failure.

| Directory under invalid/ | Rejection reason |
| --- | --- |
| `20260826-110001-b1000001` | Truncated/malformed JSON |
| `20260826-110002-b1000002` | Unsupported schema version 2 |
| `20260826-110003-b1000003` | Otherwise valid stored ID differs from directory identity |
| `20260826-110004-b1000004` | Unknown top-level spec_generation field |
| `20260826-110005-b1000005` | Unsupported nested persisted loop steps field |
| `20260826-110006-b1000006` | Impossible UTC calendar date (February 30) |
| `20260826-110007-b1000007` | Unsupported run status unknown (v2 attempt outcomes do not extend v1 statuses) |
| `20260826-110008-b1000008` | Artifact path traversal |
| `20260826-110009-b1000009` | Current artifact is not the last version |
| `20260826-110010-b100000a` | Duplicate artifact version path |
| `20260826-110011-b100000b` | Empty artifact versions array |
| `20260826-110012-b100000c` | Resolved revision without resolved_at |
| `20260826-110013-b100000d` | Pending revision with resolved_at |
| `20260826-110014-b100000e` | More than one pending revision |
| `20260826-110015-b100000f` | Pending revision is not the latest record |
| `20260826-110016-b1000010` | Whitespace-only revision feedback |
| `20260826-110017-b1000011` | Empty revisions array |
| `20260826-110018-b1000012` | Negative step attempt count |

These examples are representative, not exhaustive validity rules or license to reject other historically valid v1 data. They supplement, not replace or weaken, existing tests.

## Manifest and maintenance contract

`manifest.json` contains a sorted entry for every file in this corpus except the manifest itself: relative POSIX path, raw byte size, and lowercase SHA-256. This includes this README, .gitattributes, all valid/invalid run files, artifacts, workflow context, and session data. Self-hashing the manifest inside itself is not feasible; its own byte size and SHA-256 are hard-coded separately in the regression test. Thus every corpus file, including the manifest, has an independently stored frozen expectation.

The test computes observed byte sizes/hashes and compares them to the literal expectations. It never writes, updates, or auto-accepts a manifest. It also checks the complete file inventory (no missing, extra, duplicate, or symlink payloads) and that every valid/invalid run is classified and tested. Hash raw bytes before decoding: whitespace, final newlines, and UTF-8 encoding are part of this contract. All files use LF; the corpus .gitattributes disables text conversion so Git preserves these bytes regardless of core.autocrlf.

Initial hashes are calculated once while authoring this corpus, not from regenerated production objects. Existing payload bytes must remain unchanged. New coverage requires explicit review of new literal files, additive manifest entries, and the new manifest pin in the test; never bulk-refresh old hashes to accommodate a schema change. No automatic snapshot updater is provided.

These hashes prove the frozen fixture bytes, not historical hash-addressing, approval identities, or content at a real past execution. Missing v1 provenance stays missing. Migration must be explicit, non-destructive, restartable, and provenance-preserving.
