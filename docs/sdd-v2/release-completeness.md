# Aira v2 release-completeness requirements

Status: accepted, normative release gates under [ADR-011](adr/011-versioned-behavioral-assets.md)
and INV-BUILTIN-005/007, INV-DOC-001. This is a requirements checklist, not a claim that
these assets, documentation, integrations or examples have been implemented.

V2 MUST ship production-grade, versioned, hash-identified, independently tested built-ins.
Placeholder prompts, generic aliases for every kind/mode and unfinished documentation
do not constitute a release-complete v2 product. Assets shipped together have an exact
bundle manifest; scenarios must retain exact resolved asset attribution.

## Host skill

At minimum, a production-grade Host Pi Aira skill MUST cover:

- intent discussion and Spec creation;
- findings presentation, approval behavior and revisions;
- execution supervision and recovery;
- state authenticity: committed Aira state, not model claims, is authoritative.

## Prompt and analysis profiles

At minimum:

- clarification;
- product generation and product analysis;
- requirements generation and requirements analysis;
- architecture generation and architecture analysis;
- program-design generation and program-design analysis;
- slice-plan generation and slice-plan analysis;
- task generation and task analysis;
- implementation and repair;
- implementation review and verification review;
- final consistency review (`final-spec-review` behavioral role).

Content tests MUST independently exercise intended phase behavior, output contract,
edge cases, refusal to invent approvals/state, and interactions with context/policy.
A valid schema or content hash alone does not establish production content quality.

## Spec-kind and mode profiles

At minimum, meaningful differentiated built-ins for:

- **feature**: Product user outcomes/value, Requirements for new behavior, Architecture
  integration, concrete Program Design, incremental user-visible Slices and implementation;
- **bugfix**: Product failure/impact, corrected behavior and regression requirements,
  root-cause boundaries and fault paths, reproduction/fix/regression-proof Slices;
- **refactor**: reasons for change without behavior regression, preservation requirements,
  target boundaries/dependencies, move/extract/reshape design and verifiable checkpoints;
- **migration**: Product migration motivation, data safety/compatibility requirements,
  old/new topology, code/data transitions and preparation/dual-compatibility/cutover/cleanup Slices.

All six planning layers MUST receive meaningful differentiated behavioral selections.
These are content quality requirements, not hard-coded prose in the core domain.

The domain also supports explicitly named custom kinds. Requirements-first, architecture-first
and quick have explicit production-grade mode configuration where behavior differs,
while retaining the same canonical artifacts and hard lifecycle rules. Tests MUST
establish that kind/mode distinctions are meaningful, not just renamed minimal aliases.

## Context, capabilities, verification and execution

Context templates/profiles MUST cover at least **product**, **architecture**,
**conventions** and **security**.

Capability profiles MUST cover at least **readonly-analysis**, **architecture-analysis**,
**program-design-analysis**, **slice-plan-analysis**, **implementation** and **verification**, subject to actual backend enforcement guarantees.
They must not claim that prompt advice, a worktree or a Pi hook enforces confinement.
Verification profiles, execution profiles and execution recipes used by these built-ins
must be production-grade, tested and pinned as well. Parent restrictions and lifecycle
invariants remain authoritative for all selections and project overrides.

## User documentation

A stable user-facing SDD capability is not release-complete until its conceptual and
reference documentation exists. At minimum v2 MUST ship documentation for:

- getting started;
- the conceptual SDD model;
- Specs, Product versus Requirements, System Architecture versus Program Design, and Vertical Slices versus Tasks;
- approvals and revisions;
- context;
- capabilities and security;
- verification and evidence;
- execution and recovery;
- CLI;
- Pi integration;
- Core API;
- migration;
- architecture and reference.

Descriptions must explain authority, exact attribution, overrides, errors and recovery,
not just command syntax. Architecture documents alone do not replace user documentation.

## End-to-end examples

Release-tested examples MUST include:

1. requirements-first feature;
2. architecture-first feature;
3. quick Spec;
4. bugfix;
5. refactor;
6. migration;
7. revision causing staleness and regeneration;
8. interrupted and recovered execution;
9. capability denial and escalation.

Examples must exercise the production built-in library and show exact versioned asset
attribution, authentic approval/state transitions and relevant safety behavior. Their
implementation belongs to later content/integration stages, not this pure-domain change.
