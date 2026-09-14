# ADR-004: Architecture-first provenance without circular derivation

Status: accepted. Normative for v2. Stage 05B explicitly evolves the original
pre-release design-first terminology under [ADR-012](012-canonical-planning-ontology.md).
This stable document path is retained for existing references, not as a canonical mode.

## Context

Architecture can inform Requirements and later be checked against them without being
derived from its own descendant. Rewriting provenance or duplicating unchanged content
to force a linear pipeline would misrepresent history. Architecture and Program Design
are now distinct canonical artifacts, and Product intent precedes both authoring orders.

## Decision

- `derived_from`: immutable generation/content provenance between exact revision/hash
  identities. The derivation graph must remain acyclic.
- `validated_against`: exact-bound analysis/applicability. It records consistency against
  other revisions and findings/outcome; it is not derivation and does not rewrite content.

Requirements-first:

```text
Intent -> Product p1 -> Requirements r1 -> Architecture a1
       -> Program Design pd1 -> Slice Plan s1 -> Tasks t1
```

Architecture-first:

```text
Intent -> Product p1
Product p1 -> Architecture proposal a1 derived_from p1
Product p1 + Architecture a1 -> Requirements r1 derived_from [p1, a1]
Architecture a1 validated_against Requirements r1
Architecture a1 + Requirements r1 -> Program Design pd1 -> Slices -> Tasks
```

The consistency line is a separate committed applicability/analysis record, never a
retroactive `a1 derived_from r1` edge. Revision identities and hashes remain immutable.

### Architecture-first lifecycle

1. Author/analyze/approve Product and propose Architecture from that Product.
2. Approve the exact Architecture artifact under the configured human gates.
3. Generate/analyze Requirements from Product plus that approved Architecture.
4. Approve the exact Requirements artifact.
5. Analyze Architecture against current Requirements, binding exact inputs/findings.
6. If consistent without content changes, record validation for the same a1. Do not
   fabricate a duplicate revision or redundant human content approval.
7. If content must change, publish a2, which may derive from a1/r1, with appropriate
   new approval and explicit resulting consistency validation.
8. Author Program Design, Slices and Tasks only with applicable upstream planning and
   mutually consistent Requirements/Architecture. Tasks cannot authorize execution
   without the complete chain and required approvals.

Derivation records influence at creation; applicability records current usability.
Earlier Architecture approval alone does not prove later Requirement consistency.
Current carry-forward still follows [ADR-003](003-generation-and-fencing.md).

### Quick mode

Quick creates and analyzes Product, Requirements, Architecture, Program Design, Slices
and Tasks under either authoring order. It removes intermediate human interruptions,
not quality, consistency, traceability or completion obligations. A final explicit human
operation binds all six exact revision/hash subjects and observed Spec generation,
atomically recording individual applicability. Partial/inconsistent/stale sets fail.

### Revisions and staleness

Revision feedback records exact targets, actor provenance and resolution. Findings,
waivers and revalidation are explicit Spec mutations. Relevant changes invalidate only
causally dependent downstream applicability while preserving history. Unchanged scoped
inputs may retain applicability using exact measured entity hashes; absent observations
fail closed. Invalidation cannot return through reverse validation to invalidate its own
new authoritative input. Independent invalidations still win. Required coverage gaps
need resolution or an explicitly policy-authorized waiver; waivers never invent evidence.

## Invariants

INV-LINEAGE-001/002/003, INV-SPEC-003, INV-APPROVAL-003, INV-TRACE-001/002,
INV-PRODUCT-001, INV-ARCH-001, INV-PROGDESIGN-001, INV-SLICE-001/002/003/004.
