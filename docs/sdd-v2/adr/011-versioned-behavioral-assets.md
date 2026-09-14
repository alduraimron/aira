# ADR-011: Versioned built-in assets and behavioral profiles

Status: accepted, normative for the first v2 domain and persistence contracts.

## Context

The pure v2 domain already identifies artifacts, policies, execution profiles, context
snapshots and verifiers. It does not follow that a filename identifying the prompt,
skill or profile used to produce those objects is reproducible. These Aira-owned
inputs materially influence generation, analysis, decisions, execution and evidence.
Freezing storage before giving them exact identities would lose behavioral provenance.

## Decision

### Product code and immutable publication

Aira-owned behavioral assets are **product code**, not replaceable examples or generated
Spec artifacts. They MUST be versioned, independently testable, and subject to production
content quality gates. Published revisions, including their identity, provenance,
compatibility, metadata and predecessor relationships, are immutable. A change publishes
a new revision; a changed distribution/default publishes a new bundle revision.

The pure `src/builtins/` boundary owns schemas, references, profiles, compatibility,
resolution and attribution validation. It does not read package metadata, directories,
Markdown or files. It is not `src/artifacts/` and does not implement a registry/store.

The closed first asset-kind vocabulary is:

- `prompt-profile`, `analysis-profile`, `spec-kind-profile`, `mode-profile`, `skill`;
- `context-profile`, `capability-policy-profile`, `verification-profile`;
- `execution-profile`, `execution-recipe`.

Unknown kinds, roles, provenance sources and enclosing schema versions fail closed.
Adding them requires explicit versioned schema evolution, not arbitrary extension keys.

### Identity, content and provenance

Logical `BuiltinAssetId` values use `builtin.<dotted-name>` or
`project.<project-owner>.<dotted-name>`. The name describes identity, not a lookup path.
Asset and bundle revisions are separately branded, positive canonical decimal u64
strings. A revision is not the asset ID. Bundle IDs use `bundle.aira.<dotted-name>`.
The decimal revision and content hash, not a package version label, identify execution
inputs. `latest`, `current`, floating ranges and equivalent revision aliases are invalid.

All hashes reuse the existing lowercase `sha256:<64 hex digits>` representation.
`aira.dev/asset-bytes/raw/v1` identifies effective raw content bytes, with **no implicit
normalization**. A future normalization would require an explicit new encoding contract.
A prompt/skill body is not embedded in a domain revision. Structured kind/mode profile
configuration is a decoded domain value, not prompt content.

Self-identifying envelopes are not self-hashed. The `asset` field on a decoded kind/mode
configuration is its attached identity envelope, outside the effective content body.
Likewise a bundle/snapshot's own `identity` is outside its hashed body. For structured
profiles the body includes its schema and behavioral configuration, including exact
selected references, but excludes that self-identity envelope. Typed profile/policy body
hashes and the behavioral asset body hash identify different subjects and need not be
equal. Byte encoding/decoding and cryptographic measurement are future adapter duties;
`canonical()` remains only a comparison helper, never a hash algorithm.

Provenance is explicitly `aira-builtin` (publisher `aira`) or `project` (named logical
owner). Namespace and owner MUST agree. A project override uses project identity and
provenance, even if it fills the same logical role as a built-in. It MUST NOT overwrite
or impersonate the built-in. Selecting the actual unchanged published built-in is not
an override and retains its original provenance. Project pins cannot claim membership
in an Aira distribution bundle.

A provenance declaration is not authentication. A future trusted content decoder must
verify published ownership, immutable identity-to-content mappings, measured bytes and
that decoded configuration/typed references actually describe those bytes. The pure
catalog accepts these explicit observations (`verified_content_hash`) as inputs and
compares them against exact pins; it does not manufacture trust by copying a declared
hash. Publication must also use the immutable revision/bundle/history validators.

### Roles, kinds and modes

A role describes what is needed; a pin describes exactly what satisfies it. Closed roles
cover clarification; Product/Requirements/Architecture/Program Design/Slice Plan/Task generation and analysis (twelve roles); implementation;
repair; implementation, verification and final Spec review; context, capability,
verification and execution profiles; execution recipes; kind/mode profiles; and the Host
skill. Each role has allowed asset kinds. A role mapping is a validated selection list,
not an arbitrary string map. Required roles are explicit.

Kind profiles bind their own immutable asset revision, the existing Spec kind and exact
behavioral selections/required roles. Feature, bugfix, refactor, migration and explicitly
named custom kinds are supported. Nonempty selections are required; profiles cannot
recursively select other kind/mode profiles. Kind is not cosmetic metadata. Later product
content MUST differentiate feature requirements/architecture/task planning, bug reproduction,
root cause and regression verification, refactor behavior/architecture preservation,
and migration compatibility windows, rollback and partial-failure handling. Different
names pointing to one generic minimal behavior do not satisfy release quality.

Mode profiles use the same canonical artifact schemas. They configure authoring order,
analysis selection and approval/review presentation **within** lifecycle constraints.
Requirements-first and architecture-first keep per-artifact presentation and matching order.
Quick supports either authoring order, integrated human approval presentation and an
integrated view retaining canonical analyses. No profile can disable canonical artifacts,
analyses, consistency, approvals, traceability, completion rules or fencing. Lifecycle
and human authority remain in the existing domain evaluators, not in profile content.

### Bundle and deterministic resolution

`BuiltinBundleManifest` identifies a shipped set using its own schema, exact bundle
revision/hash, distribution version label, compatibility, contained exact asset
references, role defaults, and typed kind/mode defaults. Multiple revisions of one asset
are legal; duplicate asset/revision pairs, inconsistent references/hashes, ambiguous
defaults and project-owned members are not. Default references must be contained in the
manifest. They omit the enclosing bundle's own reference to avoid a self-hash cycle;
resolution attaches the exact bundle reference when selecting them. Whole-bundle
publication validation also checks every member's availability, nested profile selections
against the contained set, and the actual kind/mode configuration behind each mapping.
Resolution itself may be supplied only the exact members needed for its requested roles.

The pure resolution precedence for ordinary roles is:

1. explicit task selection, only for permitted execution/review/context/policy roles;
2. explicit Spec selection;
3. selected Spec-kind profile;
4. selected mode profile;
5. selected Aira bundle defaults.

Kind specializes generic mode behavior. This deliberately orders the otherwise ambiguous
kind/mode tier; a mode still cannot be incompatible with the actual Spec mode/order.
Explicit Spec-level kind/mode selectors override the corresponding typed bundle defaults.
Profile selections are exact already; the resolver never searches for newer revisions.
Only requested roles, kind-required roles and selected kind/mode identities are resolved.

**Capability selection is restriction composition, not replacement.** Every applicable
bundle, mode, kind, Spec and task restriction layer is retained. The existing deny-wins
policy compiler evaluates all layers and unions backend requirements. Repeated identical
asset selections are idempotent; their selection sources remain inspectable. No child
selection can widen access or bypass unenforceable hard requirements.

Resolution returns structured decisions containing ordered source candidates, the
replacement/restrict-all strategy and exact effective pins. Duplicate/ambiguous entries,
unresolved required roles and unavailable exact candidates fail closed. Even shadowed
candidates for a resolved role are checked; no broken explicit reference silently falls
back. Active compatibility cannot be satisfied by an unselected catalog asset.

Compatibility is structured: accepted domain schemas, required contract schemas, a
closed runtime-capability vocabulary, existing backend capability guarantees, optional
exact backend implementation/configuration identities and versioned provided/required
asset interfaces. Evaluation is set membership and exact matching, not a package-manager
solver. Missing, unknown, incompatible or observed-hash-mismatched pins block durable use
and dispatch. No live registry defaults, filesystem search, package reads or sandbox
implementation are part of resolution.

### Spec and execution attribution

A `BehavioralAssetPin` records role, asset ID/kind, exact revision/hash, provenance, typed
domain reference when applicable, and exact bundle reference when applicable. Exported
pin/revision/snapshot types are deeply readonly. Parsing/resolution returns detached
values. Physical immutability and retention are later store obligations, not promises
made by a TypeScript annotation.

Choose **phase-specific immutable snapshots**, not one mutable Spec profile. Each
`BehavioralProfileSnapshot` binds an observed Spec generation, phase, exact identity/hash,
request and resolved decisions. The Spec carries explicit selections for future behavior
and an append-only output-revision-to-snapshot binding history. Product, Requirements, Architecture, Program Design, Slice Plan and Tasks generation
and their six analyses can each use different snapshots. Analysis
bindings identify the analysis artifact revision, not just the analyzed document.
Generated artifact provenance contains its snapshot reference. Human-authored unassisted
content can have no behavioral input; missing fields never mean to resolve current
defaults. The Spec still explicitly stores empty selection/history lists in that case.

Adopting selections or adding profile bindings is a Spec semantic mutation requiring a
new Spec generation. Existing bindings and artifact provenance cannot be rewritten.
Existing lineage/invalidation, approvals and active-run fencing rules still apply to
relevant mutations. In particular architecture-first revalidation can use a new analysis
profile while the unchanged approved architecture retains its original authoring profile.
Changing future defaults does not reinterpret existing Spec/run pins or automatically
regenerate history. Snapshot validation replays the recorded exact request against its
pinned catalog inputs, not the distribution now installed by default.

An approved Spec/run snapshot contains exact authoring binding history and resolved
execution asset pins. Attempts record purpose and exact used pins, including the required
purpose, context, capability and execution profile. Repair/review use must identify their
actual inputs. Context snapshots bind their context profile pin. Evidence binds its
verification profile and policy pins, may identify exact analysis/review assets, and can
only attribute pins present in its attempt; capability layers cannot be omitted.
Execution recipes can be pinned alongside execution profiles. No full asset records are
copied into attempts or evidence. Historical execution stays attributable after defaults
evolve; inability to load a pin prevents use, not read-only inspection of its history.

Existing `ProfileReference` and `PolicyReference` identities are reused. Context pins
bind resolver-policy profiles, execution pins bind execution/recipe profiles, verification
pins bind the plan's existing profile, and analysis pins can bind the existing verifier's
review profile. Verifier IDs/revisions remain in verification plans/evidence; there is no
parallel BuiltinVerifierId or BuiltinCapabilityPolicyId. Adapters must validate exact
referenced typed bodies as well as the asset envelope.

Schema checks and cross-record validators are both required before publication/use.
The implementation provides snapshot replay, Spec binding/evolution, attempt context/task
binding and restriction-composition validators. Completion rechecks behavioral catalogs,
Spec/output bindings and attempt provenance as well as the existing lifecycle/evidence
rules. Evidence and approved-snapshot equality include behavioral identities. These are
pure decisions, not persistence or runtime integration.

### Release completeness

The [v2 release-completeness requirements](../release-completeness.md) are normative.
Production-grade built-in content and independent behavioral/quality tests are required
for v2 release, not optional polish after a placeholder MVP. A stable user-facing SDD
capability is not release-complete until both conceptual and reference documentation
exist, with the required end-to-end examples. This decision records the requirements;
it does not author that content or assert that those release gates already pass.

## Stage-05B planning evolution

[ADR-012](012-canonical-planning-ontology.md) retires the pre-release generic design roles
and `design-first`, introduces explicit Architecture/Program Design plus Product/Slice
roles, and versions affected enclosing profiles/bundles/resolutions/snapshots. Asset IDs,
revision/content hashes and provenance are never silently relabeled. Kind/mode profiles
can select differentiated exact assets for all twelve planning activities. No production
prompts are authored by this stage. The expanded [release checklist](../release-completeness.md)
remains mandatory. The historical initial implementation account below does not imply
that affected stage-05B enclosing schemas retain their earlier v1 identifiers.

## Consequences and compatibility

This closes an omission in the earlier domain, not a contradiction or relaxation of
ADRs 001-010. It preserves canonical artifact, generation, approval, task, policy and
recovery semantics. New attribution fields extend the as-yet-unpersisted first contract;
synthetic v2 fixtures are enriched, not migrated from v1 or weakened. V1 runtime/fixtures
are unaffected. Missing v1 provenance must never be invented by a compatibility reader.

No storage layout, SpecStore, CAS, locks, content loader, filesystem registry, scheduler,
CLI/Pi/runtime changes, built-in Markdown/skills/templates, sandbox or commit is included.

## Invariants

INV-BUILTIN-001 through INV-BUILTIN-007, INV-DOC-001, INV-DOMAIN-001,
INV-GEN-002/003, INV-LINEAGE-001/002, INV-CAP-001/002, INV-EVIDENCE-002/003.
