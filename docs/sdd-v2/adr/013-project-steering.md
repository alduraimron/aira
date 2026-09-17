# ADR-013: Versioned project Steering above Specs

Status: accepted, normative for Steering stages 05C-1 through 05C-5.

## Context

The canonical SDD ontology identifies what one Spec plans and executes, and the
behavioral asset domain identifies how Aira performs that work. Neither domain
represents persistent project knowledge such as architecture boundaries,
technology constraints, engineering standards, security rules, or operational
expectations.

Treating that knowledge as mutable prompt text would lose identity, attribution,
conflict handling, reproducibility, and the distinction between advice and real
enforcement. Treating it as Spec content would duplicate project rules and make
unrelated Specs own project authority. Treating English policy as a capability
boundary would contradict ADR-006.

## Decision

Adopt the complete [Project Steering contract](../steering-contract.md).

1. Steering is project-level state above individual Specs. Specs can reference
   exact Steering snapshots but do not own Steering resources.
2. Every Steering resource has stable logical identity. Revisions and bodies are
   immutable, versioned, and content-addressed independently of materialization
   paths.
3. Steering is a first-class source of planning, review, execution, and
   verification context, not an untracked prompt appendix.
4. Every planning or execution action that uses Steering pins the exact resolved
   result through a `SteeringSnapshot`.
5. Publishing a later Steering revision does not retroactively alter an existing
   snapshot, artifact, approval, attempt, evidence record, or historical meaning.
6. Authority is explicit and closed: descriptive, normative, or enforceable.
7. English prose, prompt position, a model promise, or a normative label does not
   imply machine enforcement.
8. Enforceable claims require typed exact Policy, Verifier, repository-check, or
   versioned extension linkage. Availability and actual backend enforcement are
   separately validated and fail closed.
9. Steering resolution is deterministic over exact declared inputs, canonical
   selector grammar, semantic hierarchy, scope, authority, and compatibility.
10. Conflicts are explicit outcomes. They are not silently resolved by directory
    enumeration, lexical filename, insertion order, timestamp, prompt order, or
    last write.
11. Project-specific content retains project provenance. Imported, transformed,
    interoperability, and template origins remain visible through exact source
    links.
12. Built-in templates are initialization sources, not authoritative project
    Steering. Instantiation/adoption publishes a project revision with project
    provenance and exact source attribution.
13. A worker can propose Steering changes but cannot silently publish, select,
    adopt, or mutate the Steering constraints governing its own operation.
14. `AGENTS.md` is a future interoperability input. Its existence does not make
    it authoritative Aira state, and direct use retains exact source and adapter
    provenance.
15. Scope and inclusion are separate. Neither creates precedence or a capability
    grant. Explicit Spec/manual selection affects eligibility, not authority.
16. Project overrides target exact upstream revisions/rules and are valid only
    under declared override policy, provable scope relationships, authority
    non-weakening, and retained enforcement restrictions.
17. Required enforceable and capability restrictions are monotone through lower
    layers. Existing deny-wins capability composition remains authoritative.
18. `ContextSnapshot` and `SteeringSnapshot` remain distinct. Future Context
    contains or references exact resolved Steering together with other immutable
    action inputs.
19. Behavioral assets remain separate. They identify how content was generated
    or analyzed; Steering identifies what project knowledge and rules govern it.
20. Steering revision bytes use existing BlobStore hash semantics without
    invisible whitespace or Markdown normalization.

The first persisted resource envelope is
`aira.dev/steering-resource/v1`, with exact body bytes identified by
`aira.dev/steering-bytes/raw/v1`. Embedded rule, inclusion, scope, provenance,
composition, and enforcement values are versioned by that envelope rather than
being mislabeled as independently persisted schemas. The target snapshot and
resolver contracts are `aira.dev/steering-snapshot/v1` and
`aira.dev/steering-resolution/v1`.

## Consequences

A new pure `src/steering/` domain owns logical IDs, kinds, authority, rule
metadata, typed bindings, inclusion, scope, provenance, composition declarations,
and revision integrity. It imports only pure domain contracts and Zod. It does
not read files, resolve Context, invoke Pi, execute policies/verifiers, or publish
storage.

Semantic conflict handling can be deterministic for structured keys, effects,
and values, but Aira does not claim arbitrary English theorem proving. Opaque
semantic ambiguity is surfaced for review and fails closed when required.

Template and import adoption creates new project-owned revisions rather than
rewriting source attribution. Direct interoperability remains separately
attributed and cannot weaken native enforceable policy.

The delivery sequence is fixed in the master contract: 05C-2 composition,
05C-3 snapshots/storage/staleness, 05C-4 project and `AGENTS.md` adapters, and
05C-5 adversarial/integration audit. Staging does not weaken the target decisions.

No Steering resolver, filesystem materialization, storage publication, Context
integration, worker integration, runtime enforcement, CLI/Pi UX, built-in content,
or Git commit is part of 05C-1.

## Invariants

INV-STEER-001 through INV-STEER-013, INV-DOMAIN-001, INV-CONTEXT-001,
INV-CAP-001 through INV-CAP-004, INV-BUILTIN-001 through INV-BUILTIN-004,
INV-LINEAGE-001/003, and INV-STORE-001 through INV-STORE-004.
