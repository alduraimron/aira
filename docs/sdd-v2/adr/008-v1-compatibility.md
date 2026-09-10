# ADR-008: Read-only v1 history and explicit migration

Status: accepted. Normative for v2.

## Context

V1 uses strict run schema version 1, atomic replacement of `run.json` without transactional CAS, mutable/path-addressed artifacts, generic approval results, and per-step state that can overwrite prior attempt details. The baseline has 748 passing tests and a passing typecheck. This evidence must not be reinterpreted as v2 provenance or strong recovery guarantees.

## Decision

Every valid historical v1 run MUST remain inspectable/readable. The eventual `src/legacy/v1/**` reader/projection is read-only compatibility code and MUST NOT import v2 mutation logic. Reading history cannot require regenerating current default workflows, recovering old provider credentials/config, or making the run executable under v2.

V2 is not required to safely resume an interrupted v1 run. This does not remove or alter current v1 resume/approval behavior in this change. Historical readability and eligibility for new execution are distinct contracts.

V2 MUST NOT fabricate absent information, including:

- historical content hashes that cannot be proven;
- overwritten/lost artifact versions;
- exact human approval identities or artifact/hash-bound approval subjects;
- exact old model/configuration/context snapshots;
- missing prior attempt evidence;
- invented derivation or applicability lineage.

A v1 `result: approved` is a generic recorded recipe result, not a v2 exact-bound approval. Do not convert it automatically. A digest computed while inspecting/importing surviving bytes may identify those **observed bytes at inspection/import**, with that provenance; it is not proof of bytes present at the historical approval/execution time. Missing references must be reported honestly without making an otherwise valid run uninspectable or manufacturing content.

Migration is explicit, non-destructive, restartable, and provenance-preserving. Its boundary is inspect -> plan -> import -> report. Preserve the source bytes and identities, record source-to-import mapping and uncertainties, use transaction identities for restartability, and request new v2 approvals/evidence when required. Never rewrite legacy source history as an implicit side effect of opening it.

## Frozen corpus

[tests/fixtures/legacy-v1](../../../tests/fixtures/legacy-v1/README.md) contains literal synthetic snapshots authored to the current v1 schema and transitions, not claimed captures of real user runs. A checked-in manifest records paths, byte sizes, and SHA-256; the regression test additionally pins the manifest's own bytes/hash. Tests read snapshots directly through current `loadRun()` and artifact readers without builders, schema-generated fixtures, or current default workflows.

The corpus covers all six run statuses, approval waiting/cancellation, single/multiple/non-versioned artifacts, resolved and latest pending revisions, flat loop state, shell result fields, and agent result/artifact fields. Negative literal samples pin important strict-schema rejections and directory identity enforcement. Corpus coverage is representative, not an exhaustive replacement for all existing schema/history tests; valid v1 data outside these examples remains supported.

The strict v1 schema has no richer typed loop tree, shell-result object, or v2 approval/evidence/unknown-outcome fields. Existing flat step fields express the requested historical states, including a pending revision checkpoint, without changing the schema. Do not infer loop structure, missing earlier iterations, or exact approval subjects from those fields. Fixture workflow declarations, when supplied, are separately labeled fixture context, not newly invented persisted run metadata.

## Consequences

Later reader extraction must retain the accepted v1 contract, including its omissions and limitations. Existing snapshots and their hashes are not automatically refreshed when schemas change. New coverage is additive and explicitly reviewed; corruption samples do not license tightening validity beyond what v1 historically accepted.

## Invariants

INV-LEGACY-001, INV-LEGACY-002, INV-LEGACY-003, INV-APPROVAL-001.
