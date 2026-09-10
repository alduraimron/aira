# ADR-004: Design-first provenance without circular derivation

Status: accepted. Normative for v2.

## Context

A design can inform requirements and later be checked against them without being derived from its own descendant. Rewriting provenance or duplicating unchanged content to force a linear pipeline would misrepresent history.

## Decision

Model relationship semantics explicitly:

- `derived_from`: immutable generation/content provenance between exact revision identities. The derivation graph must not contain a cycle.
- `validated_against`: an exact-bound analysis/applicability relationship. It records consistency against other revisions and its findings/outcome; it is not derivation and does not rewrite artifact content.

Requirements-first:

```text
Requirements r1 -> Design d1 derived_from r1
```

Design-first:

```text
Intent i1 -> Design d1 derived_from i1
Intent i1 + Design d1 -> Requirements r1 derived_from [i1, d1]
Design d1 validated_against Requirements r1
```

The final line is a separate committed applicability/analysis record, not a retroactive `d1 derived_from r1` edge. Revision identities and content hashes remain immutable.

### Design-first lifecycle

1. Propose an initial design from intent.
2. A human approves the exact design artifact.
3. Generate requirements from intent plus that approved design.
4. A human approves the exact requirements artifact.
5. Analyze the design against current requirements, recording exact revision/hash inputs and structured consistency findings.
6. If design content is unchanged and analysis proves consistency, record `validated_against` applicability for the same d1. Do not manufacture a duplicate content revision or a redundant content approval merely to enforce a false derivation order.
7. If content must change, publish d2, which may be `derived_from: [d1, r1]`. It requires appropriate human approval before becoming current and applicable; analyze resulting consistency explicitly.
8. Tasks may become current only after requirements and applicable design are mutually consistent and the mode's required human gates are satisfied.

Derivation records what influenced creation. Applicability records whether a revision can be used now. Earlier approval of d1 alone does not prove consistency against later requirements. An analysis may change applicability/Spec generation without changing artifact content identity; exact approval carry-forward follows [ADR-003](003-generation-and-fencing.md).

### Quick mode

Quick mode produces the same canonical requirements, design, and structured tasks, including required analyses/validation and traceability. It removes intermediate human gates, including any intermediate gates of the chosen authoring order, not consistency obligations. Tasks can be proposed for integrated review before human approval but cannot authorize execution then.

At final integrated review, a single explicit human decision may approve the exact requirements/design/task revision/hash set and observed Spec generation. The transaction records individual artifact approval applicability. It must reject stale, inconsistent, or partially valid sets, rather than approving an opaque bundle name.

### Revision, findings, and invalidation

Revision feedback records requested change, exact targets, actor provenance, and resolution. Findings bind analyzed revisions and retain historical disposition; resolution, waiver, and revalidation are explicit Spec mutations. Relevant upstream changes invalidate affected downstream applicability (design, tasks, approvals, runs, evidence, completion) transitively. Preserve old records; never silently make them current by following a reused path. Revalidate unchanged content explicitly against exact current inputs. MUST-level traceability gaps require resolution or an explicit policy-authorized human waiver.

## Consequences

The first schema needs typed relationships, analysis/applicability records, and downstream invalidation, not one untyped list of parent filenames. No circular lineage is necessary, and no locked lifecycle decision is technically contradictory.

## Invariants

INV-LINEAGE-001, INV-LINEAGE-002, INV-LINEAGE-003, INV-SPEC-003, INV-APPROVAL-003, INV-TRACE-001.
