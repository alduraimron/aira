# Steering 05C-2: pure deterministic resolution

Status: implemented. The [master contract](steering-contract.md),
[ADR-013](adr/013-project-steering.md), and INV-STEER-001 through INV-STEER-013
remain normative. This document specifies the conservative v1 resolver policy,
not an alternative Steering architecture.

## API and trust boundary

`resolveSteering(request)` is exported from `src/steering/index.ts`.
`SteeringResolutionRequest` contains:

- `schema: aira.dev/steering-resolution/v1`;
- `policy: aira.dev/steering-policy/conservative/v1`;
- `project`, reusing the 05C-1 project/control namespace;
- `catalog`: exact available `SteeringResourceRevision` values;
- `selections`: exact revision expectations with existing inclusion declarations;
- `action`: required phase, optional Spec/Task identities and existing kind
  selectors, and optional known/unknown logical touched-path observation;
- `manual`: exact resource/rule selections, required/optional availability, and
  project-bound human/operation/channel authorization provenance;
- `supported_contracts`: explicitly supported versioned contracts;
- `available_enforcement`: exact, caller-validated available mechanism bindings.

The catalog is availability, not an implicit current-revision registry. The
trusted caller must supply the complete action's registry/selection expectations,
including references whose required revisions are unavailable. Catalog presence
alone does not select a resource. Exact parents of included resources are also
required. Multiple catalog revisions are allowed; multiple simultaneously
included revisions of one logical resource are not.

Selections intersect, never replace, a resource's own inclusion/scope. Manual
selection can introduce an exact candidate but cannot bypass those declarations,
select every rule in it, or authorize an override. Overrides come from the exact
revision's `composition.overrides`, not a mutable ambient override table.

The pure API consumes validated control-plane observations. A self-declared
human actor or available binding is not authentication. Later adapters must
validate authorization, publication, bytes, mechanism availability/compatibility,
and backend usability before durable use. This API does not load records,
authenticate bytes, check a backend, or execute enforcement. Required bindings
without an exact supplied availability observation fail resolution. Required
extension contracts must also be explicitly supported.

## Result

`SteeringResolutionResult` is a detached, deeply frozen discriminated union:

- `invalid-input`: malformed declarations, invalid hierarchy, or invalid request;
- `conflicted`: applicable composition cannot safely resolve;
- `resolved`: complete effective semantics and enforcement requirements.

Every result identifies the exact resolver contract and policy and exposes stable
structured diagnostics. Conflicted results retain inspection traces but have no
`effective_rules` or `enforcement` success payload. Invalid inputs do not produce
a partial successful trace.

Successful and conflicted traces include normalized request inputs, exact
hierarchy order, included revision comparison views, source tiers, evaluated
scope/inclusion trees, matching logical paths, selection/parent/manual reasons,
applicable rules, explicit override decisions, superseded regions, and omissions.
Included revision views preserve content references, provenance/adoption links,
rule source locations, defaults, and behavioral attribution.

Effective semantic groups retain every contributing rule, exact resource and
revision, authority, binding, and scoped region. A region consists of its source,
applicable scope, and `excluded_scopes`. Consumers MUST retain those exclusions:
a scoped exception cannot erase its parent's constraint on other touched paths.
The included revision inventory plus override edges records the full source chain,
including fully superseded contributors. Binding records retain source scopes,
not just an unqualified bag of mechanism IDs.

No result has a derived snapshot ID, snapshot hash, top-level creation timestamp, or
persistence operation. These are intermediate decisions for 05C-3.

## Algorithm

1. Bound input size/depth before recursive schema or graph work. Validate strict
   shapes, versions, logical paths, identities, duplicate sets, and authorization
   provenance. Limits include 256 resources, 256 rules/resource, 1,024 total rules,
   1,024 touched paths, 48 input levels, and 100,000 input nodes. Path/pattern
   declaration fields are bounded to 1,024 code units and 128 segments; other
   strings to 16,384 code units.
2. Build the exact parent graph. Reject missing parents, own-lineage inheritance,
   duplicate edges, cycles, cross-project edges, illegal source relationships,
   and unprovable narrowing. Validate rule scope and inclusion narrowing.
3. Produce a Kahn topological order. Resolve only explicit candidate expectations
   and their exact parent closure. Evaluate all children of scope/inclusion
   expressions, without short-circuiting away missing-input diagnostics.
4. Record every omission and applicable rule. Intersect declared scope with
   matching resource/rule inclusion and selection coverage. Manual/always nodes
   are gates, not new scope authority. Empty/unprovable coverage fails closed.
5. Bind explicit override declarations to unique applicable semantic pairs.
   Validate exact direct parent, source authority, target policy, scope proof,
   sealing, authority non-weakening, and retained enforcement.
6. Group rules by semantic key. Apply valid override region exclusions, then
   compare all remaining potentially overlapping semantic constraints. No
   conflicting rule is silently discarded.
7. Coalesce equivalent effect/value/authority groups, retaining every source and
   coverage region. Union exact bindings and validate immutable mechanism
   identities, required availability, and extension compatibility.
8. Sort decisions/diagnostics explicitly, detach and freeze the result. Any fatal
   issue prevents `resolved` status.

## Hierarchy, scope, and precedence

Only native project-scoped resources inherit native project-root/project-scoped
resources, with a declared parent and strictly narrower resource scope. Separate
roots can coexist without inheriting each other. Imported/interoperability
resources remain separately attributed candidates, cannot compose native policy,
and cannot claim enforceable authority without project adoption. Templates can
be available source records, but are never directly included as project authority.
Adoption provenance is not an inheritance edge.

Scope comparison returns `equal`, `narrower`, `wider`, `disjoint`,
`overlapping-incomparable`, or `invalid`. Exact paths and containing trees, set
inclusion for phase/Spec/Task kinds, and normalized structural AND/OR implication
supply conservative proofs. General glob containment is not inferred: identical
globs are equal; `src/auth/**` is not automatically proven a subset of `src/**`.
Authors needing that proof can use the modeled tree selectors. Glob matching
itself reuses `matchesPath` and `aira.dev/glob/v1`, without filesystem access.

Hierarchy rank and scope specificity are not precedence. Even a narrower
contradictory descriptive fact requires an explicit override when scopes overlap.
Disjoint facts can coexist, including in an action touching multiple subtrees.
Incomparable potentially overlapping constraints fail closed without a proven
safe relationship. Inclusion coverage cannot independently confer override
permission: both declared scope and effective coverage must pass the proof.

Overrides target an exact direct parent resource and optionally an exact rule.
A resource-wide target expands only into unique source/target semantic pairs;
multiple source rules in one slot are ambiguous. Duplicate, overlapping wildcard
and rule targets, or unlinked competing overrides are rejected rather than
ordered arbitrarily.

- `sealed`: every explicit descendant override attempt is fatal, including an
  identical-value or narrower-scope attempt. Compatible duplicates without an
  override retain the sealed source.
- `narrower-scope`: only explicit, provably narrower `specialize` or `strengthen`.
- `explicit-replacement`: only explicit `replace` with equal/narrower scope,
  targeting descriptive or normative declarations.
- `strengthen`: identical effect/value or cumulative prohibitions only. It
  composes rather than supersedes the upstream constraint.
- Enforceable targets: only `strengthen`, with enforceable source authority and
  every required exact upstream binding explicitly retained by the source.

## Non-weakening and compatibility

Authority never automatically downgrades. Explicit descriptive-to-normative or
normative-to-enforceable authored transitions can pass the ordinary policy/scope
checks; normative-to-descriptive and enforceable-to-normative cannot. The resolver
does not infer an authority upgrade from matching prose. Equivalent semantic
claims at different authority levels retain separate authority-specific groups,
so one scoped enforceable source cannot relabel unrelated normative coverage.

All applicable capability layers remain intact for the existing deny-wins
`composeCapabilityPolicies` compiler. No Steering-specific permission lattice,
glob permission intersection, escalation, or runtime enforcement was added.
05C-1 marks protection through enforceable authority/required bindings and sealing,
not a separate generic non-weakening lattice. A security resource kind alone does
not confer machine authority; protected normative boundaries can be sealed.
Required verifiers/checks/extensions cannot disappear, change use to advisory,
or be replaced by a different revision/hash under a strengthening declaration.
Applicable resource defaults are retained too; enforceable defaults need active
structured enforceable linkage. Same immutable mechanism identity with conflicting
hash/use/extension contract fails closed, including cross-kind verifier/check hash
conflicts.

The semantic table recognizes exact effect/canonical-value duplicates, cumulative
`forbid` values, conflicting different `require`/`describe`/`prefer` values, and
`require X` versus `forbid X`. Unequal require/forbid values can coexist. Authored
JSON arrays remain ordered; titles, Markdown, and English similarity are not
semantic identities.

## Explicit conservative choices where 05C-1 leaves safety details open

These choices are pinned by this policy and tested, not silent relaxations:

- Mixed effects not covered by the normative compatibility table conflict,
  including `prefer X` with `require X`, unless an allowed explicit override
  resolves them. No arbitrary JSON/English strengthening inference is attempted.
- Optional semantic conflicts are not automatically omitted. The contract permits
  safe optional omission but does not provide a unique omission policy; v1 fails
  closed rather than choosing a convenient candidate to drop.
- An available, matched candidate known to contain enforceable constraints cannot
  be omitted as merely optional when required compatibility is unavailable.
- Manual authority accepts human project-control provenance only. Worker/model
  self-selection and an unspecified system authorization protocol are rejected.
- Path-bearing inclusion coverage is retained in semantic regions. AND matches
  witnessed only by different disjoint paths cannot justify a fabricated common
  subject: an empty coverage intersection fails closed.
- External composition, same-scope parent inheritance, inclusion-only override
  authorization, and ambiguous source/target pairing are not guessed valid.

## Ordering and diagnostics

Ready graph nodes use source rank (`template`, `project-root`, `project-scoped`,
`interoperability`, `imported`), resource ID, revision, then exact hash. This rank
is presentation, not trust or override authority. Included resources follow the
resulting topology; applicable rules use that order then rule ID. Effective groups
use first contributing resource order, semantic key, effect, canonical value,
and authority. Override decisions use source order/rule ID then target order/rule
ID. Aggregate enforcement uses existing binding identity order. Embedded domain
sets retain their 05C-1 canonical representations. Diagnostics are deduplicated
and sorted by canonical structured representation, never input indices.

The public `steeringResolutionIssueCodes` union uses the repository's lowercase
kebab-case convention, including `steering-duplicate-resource`,
`steering-parent-cycle`, `steering-scope-widening`,
`steering-override-target-missing`, `steering-override-not-allowed`,
`steering-override-ambiguous`, `steering-sealed-rule-override`,
`steering-semantic-conflict`, `steering-authority-conflict`,
`steering-enforcement-weakening`, `steering-required-resource-missing`,
`steering-manual-selection-missing`, `steering-inclusion-input-missing`, and
`steering-conflict-unresolved`. Issues carry structured exact resources/rules,
semantic key, scopes, authorities, sealing policy, bindings, and override details
where applicable. No caller needs to parse human prose.

The resolver accepts reordered presentations of already-parsed domain sets and
produces the same comparison view. It does not change the strict authenticated
05C-1 decoder, repair duplicate/malformed declarations, reorder semantic JSON
arrays, alter body bytes, or compute hashes. Permutation tests cover resources,
parents, rules, bindings, selectors, and diagnostics. Future persisted snapshot
encoding and replay validation must consume this distinction explicitly.

Changing any of these decision semantics requires an explicit resolver policy
version change and, when representation changes, schema evolution. Neither a
package update nor a new template may reinterpret an existing pinned policy.

## Deferred

05C-3 owns snapshot construction/encoding/hashing, provider-neutral persistence,
BlobStore/registry/CAS transactions, retention, and causal staleness. 05C-4 owns
filesystem discovery, source authenticity, safe logical path observations,
materialization, adoption operations, and interoperability adapters. 05C-5 owns
the broader adversarial/integration audit. Context/worker delivery, backend
confinement, verifier execution, scheduling, and CLI/Pi UX remain outside this
pure resolver. No existing runtime or storage path calls this resolver yet.
