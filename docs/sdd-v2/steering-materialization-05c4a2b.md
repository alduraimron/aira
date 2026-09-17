# Steering 05C-4A2B: authoritative native-source materialization

Status: implemented. This slice projects exact authoritative Project Steering into
human-editable native files. It extends the native source contract in
[05C-4A1](steering-native-source-05c4a1.md), explicit adoption in
[05C-4A2A](steering-adoption-05c4a2a.md), and the authoritative registry contract
in [05C-3B1](steering-store-05c3b1.md).

## Authority boundary

```text
.aira/state/v2/steering/**  authoritative Project Steering
.aira/steering/**           human-editable native authoring material
```

Materialization is only this direction:

```text
authoritative exact revision
  -> reviewed immutable materialization plan
  -> per-file native authoring projection
```

It does not advance `SteeringGeneration`, alter Steering HEAD, publish a resource
revision, create a Steering commit, change a `SteeringSnapshot`, write a body
blob, or make a file authoritative. The application layer only reads
`SteeringStore` and `BlobStore`; it never calls `SteeringStore.commit`.

There is no bidirectional synchronization engine. Native source changes enter
authority only through a later explicit adoption. Current authority changes enter
the authoring surface only through a later explicit materialization. Timestamps,
mtimes, and last-writer rules have no reconciliation meaning.

## Module boundary

`src/steering-materialization/` is an application layer:

- `types.ts` defines strict plans, authorization, results, diagnostics, and
  identities.
- `render.ts` deterministically converts an authoritative revision to existing
  `aira.dev/steering-source/v1` framing and verifies parser round trip.
- `plan.ts` read-only loads exact authority, raw body bytes, and safe target
  observations.
- `apply.ts` checks authority and target freshness, then invokes per-file safe
  publication.
- `fs.ts` supplies bounded no-follow target observation, explicit directory
  creation, temporary publication, and directory fsync mechanics.

The pure `src/steering/**` domain remains filesystem-free. The materializer does
not inspect or write interoperability files, templates, Context, Pi, CLI,
workers, verifiers, capabilities, or Git.

## Plan contract

The immutable schema is:

```text
aira.dev/steering-materialization-plan/v1
```

Its full canonical semantic SHA-256 produces a full-digest identity:

```text
steering_materialization_plan_<64 lowercase hex>
```

A plan binds all of the following before apply:

- project/control identity and literal `.aira/steering` authoring root;
- exact authoritative Steering HEAD, CommitSequence, SteeringGeneration, and
  every selected current resource revision;
- each selected authoritative raw body hash, byte count, media type, resource
  kind, and authorable semantic projection hash;
- renderer contract/version, source schema, canonical framing encoding, and
  materialization policy version;
- one explicit target path and deterministic rendered complete-source descriptor
  for every selected resource;
- exact observed target state: absent, or existing full source hash and size plus
  device, inode, link count, and mode;
- exact planned safe directory states and exactly which absent authoring
  directories may be created;
- one concrete action per selected resource;
- explicit replacement authorization requirements when any destructive action is
  present.

Plans are canonically detached and deeply frozen. Apply never means "render
whatever is current now". A plan is rejected if its identity, action identity,
ordering, target collision checks, directory creation set, or authorization
requirements are inconsistent.

Planning is read-only. It can load current authority, immutable body blobs, and
safe source observations, but cannot create a directory, write a file, publish a
blob, acquire an authority writer lock, or mutate the registry.

## Renderer contract and semantic round trip

The renderer contract is:

```text
aira.dev/steering-materialization-renderer/native-source/v1
```

It emits existing `aira.dev/steering-source/v1`, not a second authoring format.
The YAML 1.2 frontmatter document is the deterministic canonical JSON subset of
YAML. This fixes key order, scalar spelling, whitespace, framing line endings,
and UTF-8 encoding without relying on YAML emitter insertion order or defaults.

The renderer writes authorable resource metadata, structured rules, scope,
inclusion, authority, override policy, enforcement bindings, project provenance
(authorship and optional adopted-from source), composition, compatibility,
metadata, and behavioral attribution. It does not write source-forbidden
publication fields such as revision allocation, creation metadata, predecessor
bookkeeping, operation IDs, audit metadata, or the previous native file
observation.

For every materializable revision, apply and planning prove:

```text
authoritative revision
  -> deterministic source bytes
  -> existing 05C-4A1 parser
  -> native source proposal
```

The authorable semantic projection must be equal. It includes logical ID, kind,
custom kind, project layer, project provenance excluding native observation,
content descriptor, authority, override policy, enforcement, inclusion, scope,
structured rules, composition, compatibility, metadata, and behavioral assets.
For rules it includes source location but excludes the body hash because that hash
is adapter-derived from newly parsed body bytes.

It intentionally excludes publication-owned fields: revision number allocation,
creation metadata, `supersedes`, native source observation, audit metadata, and
operation metadata. It does not claim to recreate comments or original YAML
layout from an earlier human source file.

## Exact body bytes

The raw authoritative body is appended after generated framing as opaque bytes.
The materializer does not decode/re-encode it for publication and does not trim,
normalize line endings or Unicode, add a final newline, remove a final newline,
or format Markdown. The parser-derived body hash and byte count must equal the
selected immutable authoritative body descriptor. Invalid body bytes that cannot
form valid native source fail rendering rather than being repaired.

## Target paths and comparison

Logical identity remains independent of target path. Conventional suggestions
are:

```text
product       -> .aira/steering/product.md
architecture  -> .aira/steering/architecture.md
technology    -> .aira/steering/technology.md
structure     -> .aira/steering/structure.md
engineering   -> .aira/steering/engineering.md
testing       -> .aira/steering/testing.md
security      -> .aira/steering/security.md
operations    -> .aira/steering/operations.md
custom        -> .aira/steering/custom/<logical-resource-id>.md
```

A caller may select a different explicit native source path, subject to the
native source root and bounded custom surface. A custom resource must remain
under `.aira/steering/custom/`. The filename never determines resource identity.

Planning rejects exact target collisions, portable case/Unicode-normalization
ambiguities, traversal, paths outside the authoring root, nonregular targets,
symlinks, hardlinks, unsafe directory ancestors, cross-device paths, and unsafe
or unbound directory creation. Existing sibling paths that differ only under the
portable normalization key are rejected conservatively.

Existing regular targets are parsed through the existing native source parser.
If the parsed authorable semantics and exact body descriptor equal the selected
authoritative revision, the action is `unchanged` even if comments or YAML
formatting differ. Ordinary materialization does not canonicalize or prettify
such a file.

The actions are:

- `create`: target was exactly absent.
- `unchanged`: existing native source already represents equal authorable
  semantics and exact body bytes.
- `replace`: caller explicitly selected this exact existing target for
  replacement.
- `conflict`: existing source differs or cannot prove a safe equivalent mapping.

No action infers deletion or retirement.

## Human edit protection and authorization

The default for any existing different authoring file is `conflict`. Authority
being newer never overwrites unadopted human edits. A replacement requires a
fresh plan that binds the exact prior source bytes and filesystem identity.

`replace` requires an
`aira.dev/steering-materialization-authorization/v1` decision over the exact
plan ID/hash and project from a local human-compatible actor. Worker and model
actors are rejected. No prompting UI is implemented.

A `create` into a safely observed absent native authoring target does not require
separate authorization in this slice. It is non-authoritative projection only;
any later adoption still requires its own explicit human authorization. This is
the narrower lower-risk decision and does not grant authority mutation rights.

## Two-sided freshness

Before any file write, apply verifies both sides:

1. The exact plan authority is still current: HEAD, CommitSequence,
   SteeringGeneration, selected active current resource revisions, selected raw
   descriptors, and authorable semantic hashes all match.
2. Every target and required directory is still exactly what the plan observed:
   absent stays absent; an existing source retains full source hash/size and
   filesystem identity; safe parent directories retain their planned identity.

Each individual file is revalidated again after temporary bytes are fsynced and
immediately before rename. A changed authority returns
`materialization-authority-stale`; a changed target returns
`materialization-target-stale`. Apply never replans or rebases.

## Safe directory and file publication

Only plan-bound authoring directories are created. Creation stays beneath the
trusted explicit project root, uses nonrecursive ordered `mkdir` with mode
`0700`, rejects symlinks and cross-device substitutions, validates each created
inode, and fsyncs the new directory and parent.

For each write the publication sequence is:

1. validate target and bound directory safety;
2. create an exclusive same-directory `.tmp` temporary with no-follow flags;
3. write all complete source bytes and fsync that temporary;
4. revalidate the exact target and directory preconditions;
5. atomically rename the complete temporary onto the target;
6. fsync the containing directory;
7. safely remove an unpublished temporary when the process remains alive.

The target is never opened for in-place writing. Temporary names are ignored by
the native discovery policy, so interrupted debris is not a source file or
authority. Failpoints and real SIGKILL tests cover after temp write, after temp
fsync, before target publication, after target publication, and before directory
fsync. Fresh inspection observes an absent/old complete target before publication
or a complete new target after publication, never a partially written target.

As with the existing Node filesystem adapters, pathname APIs cannot provide a
kernel-level compare-and-swap rename against a concurrently malicious trusted
control-root owner. Revalidation occurs immediately before rename; the trusted
project root must not be concurrently controlled by an untrusted actor.

## Multi-file and result semantics

Files are ordered by target path and logical resource ID in code-point order.
There is intentionally no global multi-file filesystem transaction. Each file is
atomic and durable on its own. A crash or later failure can leave a valid prefix
of materialized files, while authoritative Steering remains unchanged. Replanning
or rerunning reconciles that non-authoritative surface safely.

`aira.dev/steering-materialization-result/v1` includes plan identity, authority
HEAD/generation, selected revision references, created files, replaced files,
unchanged files, conflicts, partial-applied files, successful target source
observations, and stable diagnostics. Status is one of:

- `complete`: every planned write completed;
- `no-op`: all selected targets were unchanged;
- `partial`: at least one per-file publication completed before a later failure;
- `failed-before-write`: preflight, authorization, conflict, or first-write
  failure prevented a completed target publication.

A partial result includes `materialization-partial`; it never reports global
success for only a prefix.

## Adoption interaction

A materialized file is an ordinary native project source observation. Humans may
edit it. A later explicit adoption captures a changed exact observation in the
normal way.

A byte-exact deterministic source projection of the current revision is a
semantic no-op for adoption. This prevents the artificial cycle:

```text
authority A -> materialize -> unchanged adoption -> fabricated authority B
```

The adoption adapter recognizes only an exact renderer output, including framing
and body bytes, for this narrow no-op rule. Human edits fail that check and retain
ordinary adoption freshness and provenance behavior.

## Stable diagnostics

This slice uses stable issue codes:

- `materialization-plan-invalid`
- `materialization-authority-stale`
- `materialization-target-stale`
- `materialization-target-conflict`
- `materialization-target-collision`
- `materialization-path-unsafe`
- `materialization-replacement-unauthorized`
- `materialization-worker-unauthorized`
- `materialization-render-invalid`
- `materialization-roundtrip-mismatch`
- `materialization-partial`

## Explicitly deferred

This slice does not implement `AGENTS.md` interoperability, templates or
initialization content, `aira init`, format/canonicalization UX, automatic sync,
file watchers, automatic adoption, Context delivery, workers, capability or
verifier execution, scheduling, GC, CLI/Pi UX, or Git commits.
