# Steering 05C-4B1: AGENTS.md interoperability observation

Status: implemented. This document defines the read-only `AGENTS.md`
interoperability adapter. It extends the [Project Steering contract](steering-contract.md)
and [ADR-013](adr/013-project-steering.md) without changing native Steering,
SteeringStore, materialization, adoption, resolution, Context, or runtime policy.

## Purpose and boundary

`AGENTS.md` is an open, free-form ecosystem convention. It is not native Aira
Steering merely because it exists in a repository.

Native Aira Steering has strict schemas, structured semantic rules, explicit
authority and override declarations, exact revision history, typed enforcement
bindings, and authoritative registry state. `AGENTS.md` is opaque Markdown
guidance. These models must not be conflated.

05C-4B1 provides only this flow:

```text
AGENTS.md files
  -> exact discovery and lexical scope observations
  -> later explicit 05C-4B2 interoperability composition or import
  -> attributed Steering input
  -> existing Steering resolver
```

There is no direct `AGENTS.md -> authoritative Steering` path. This adapter
never creates a Steering revision, revision ID, registry commit, generation,
snapshot, BlobStore object, materialized file, or source mutation. It does not
call `resolveSteering`.

## Module and public API

The adapter is outside the pure Steering domain:

```text
src/steering-agents/
  types.ts       versioned contracts, policy, identities, diagnostics
  discovery.ts   bounded no-follow filesystem discovery
  inspect.ts     exact-byte observation and freshness comparison
  scope.ts       pure lexical applicability evaluation
  index.ts       public exports
```

The package export is `aira/steering-agents`.

Read-only inspection is:

```ts
inspectAgentsInterop(projectRoot, { project })
```

`projectRoot` must be an explicit absolute canonical trusted project root. The
adapter never derives it from cwd and never searches a parent directory, home
directory, or another mount.

Pure planning-time applicability is:

```ts
resolveAgentsApplicability(observations, targetPaths)
```

It takes logical project-relative target paths only and performs no filesystem
lookup. A future plan may therefore ask about a non-existing path.

The exact observation builder and freshness APIs are also public:

```ts
observeAgentsSource({ project, source_path, bytes, filesystem? })
compareAgentsObservation(reviewed, current)
agentsObservationBytes(observation)
```

`agentsObservationBytes` returns a fresh verified byte copy. `AgentsObservation`
is also exported as the non-authoritative `AgentsInteropProposal` input type for
05C-4B2. The embedded `raw_bytes` value is a detached exact byte copy; consumers
must verify it against the hash and byte count before durable use, as 05C-4B2
will do.

## Versioned observation contract

A valid observation has schema:

```text
aira.dev/steering-agents-observation/v1
```

Each observation retains:

- trusted project/control identity and logical control root `.`;
- exact project-relative `source_path`, such as `AGENTS.md` or
  `packages/api/AGENTS.md`;
- `source_identity`, a stable location identity derived from project, source
  type, source path, and scope root under
  `aira.dev/steering-agents-source-identity/v1`;
- `observation_identity`, derived from source location plus exact source hash,
  byte count, media type, discovery policy, and text encoding under
  `aira.dev/steering-agents-observation-identity/v1`;
- exact SHA-256, byte count, media type, raw-byte encoding
  `aira.dev/steering-bytes/raw/v1`, and detached raw bytes;
- strict `utf-8` text encoding declaration;
- lexical scope root and depth;
- filesystem device, inode, link count, mode, size, mtime, and ctime
  diagnostics when the observation came from the filesystem; and
- explicit `aira.dev/steering-agents-provenance/v1` interoperability
  provenance with source type `AGENTS.md`, exact path/hash, scope root, and
  discovery policy.

A source location identity is not a `SteeringResourceId`. It does not assign
`steering.architecture`, `interop.steering.agents-md`, or any other native
semantic identity. Byte changes change `observation_identity`. A move changes
source path, scope, and `source_identity` even when bytes are unchanged.
Filesystem inode is freshness and replacement evidence only. It is not logical
identity, and mtime/ctime are never content identity.

Invalid UTF-8 or NUL content is retained only as a rejected low-level file
observation with exact descriptor and bytes. It is never a valid interoperability
observation.

## Exact byte semantics

The adapter hashes exact bytes before decoding. It preserves every byte in a
valid source, including LF versus CRLF, trailing whitespace, blank lines,
absence or presence of the final newline, a UTF-8 BOM if present, Markdown
formatting, and any apparent YAML frontmatter.

It does not normalize line endings or Unicode, trim, format Markdown, inject
frontmatter, parse frontmatter, inspect headings, or extract prose rules. A
frontmatter-looking sequence is ordinary AGENTS Markdown bytes.

The adapter uses strict UTF-8 validation and rejects invalid sequences and NUL
bytes. It does not replace malformed input. Whenever bytes are safely read
within the discovery limit, the source descriptor is SHA-256 over raw bytes
independent of UTF-8 or NUL validation outcome.

## Discovery policy

The fixed policy is:

```text
aira.dev/steering-agents-discovery/v1
```

| Property | v1 value |
| --- | --- |
| trusted root | explicit project root only |
| recognized name | exactly case-sensitive `AGENTS.md` |
| discovery surface | root and nested non-excluded directories |
| max AGENTS files | 256 |
| max bytes per file | 1,048,576 |
| max aggregate candidate bytes | 8,388,608 |
| max traversal depth | 32 directory segments below project root |
| max entries per directory | 1,024 |
| max total entries | 4,096 |
| max logical path bytes | 1,024 UTF-8 bytes |
| read buffer | 65,536 bytes |
| ordering | project-relative source path, code-point order |

Traversal ignores ordinary non-AGENTS files without opening them. It does not
use `.gitignore` as an authority source. The deterministic excluded directory
names are `.git`, `.aira`, `node_modules`, and `vendor`.

Excluding `.aira` intentionally excludes both `.aira/state/**` and
`.aira/steering/**`. AGENTS guidance in Aira internal state or native authoring
surfaces is not discovered by this interoperability contract. Inspection reports
encountered policy-excluded roots in `skipped_subtrees`; exclusions do not make
the scan incomplete.

File-count, aggregate-byte, entry, depth, unreadable, and race failures mark
inspection incomplete. Known invalid sources such as an oversized file or
invalid UTF-8 make the inspection invalid, but do not falsely claim that the
traversal itself was unbounded.

A missing root `AGENTS.md` is valid. `root_status: "missing"` accurately
reports that state while nested sources may still be present.

## Path and filesystem safety

Source and target paths use the existing portable logical project path grammar:
no absolute paths, backslashes, drive-like colons, control characters, empty
segments, `.`, or `..`. Target paths are lexical and do not need to exist.

Discovery performs bounded directory enumeration and uses lstat checks,
canonical realpath checks, same-device checks, `O_NOFOLLOW`, `O_NONBLOCK`,
opened-handle identity checks, bounded chunked reads, pathname rechecks, and
final stat checks. It rejects or safely reports:

- symlinked project roots, traversed directories, or `AGENTS.md` files;
- a source outside the trusted root or on another device;
- non-regular files, FIFOs, sockets, devices, and hardlinked AGENTS files;
- mutable replacement or content races detectable with current Node primitives;
- invalid logical paths and unsupported bounds.

No symlink is followed for discovery, including an external symlink mount.
Directory identities are rechecked after discovery. As with existing Node
filesystem adapters, these pathname primitives cannot claim kernel-level
protection from a concurrently malicious owner of the trusted project root. The
trusted root must remain unavailable to untrusted concurrent workers.

## Nested scope and nearest convention

Each valid observation applies lexically to the directory that contains it and
its descendants:

```text
AGENTS.md                    scope root = .
packages/api/AGENTS.md       scope root = packages/api
packages/api/src/AGENTS.md   scope root = packages/api/src
```

For `packages/api/src/user.ts`, applicability is returned broadest to nearest:

```text
AGENTS.md
-> packages/api/AGENTS.md
-> packages/api/src/AGENTS.md
```

For `packages/web/src/app.ts`, an API-specific observation does not apply.
Scope calculation is structural, uses source path and target strings only, and
does not depend on directory enumeration order or target file existence.

The returned order represents the ordinary AGENTS nearest-file convention. It
is explicitly named only as interoperability precedence. It is not Aira native
rule override authority, native hierarchy, semantic precedence, inclusion,
scope proof, or a capability grant. 05C-4B1 does not decide whether prose in a
nearer AGENTS file wins over native structured Steering.

## Multiple targets

Applicability always remains per target. For API and Web work, the result has a
separate broadest-to-nearest chain for each logical target. It never flattens
those chains into one invented global nearest file.

The result additionally exposes:

- `common_observations`, guidance structurally applicable to every target; and
- `path_specific_guidance`, each observation with the exact subset of target
  paths to which it applies.

This is structural scope grouping only. It performs no Markdown conflict,
equivalence, or semantic analysis.

Duplicate logical observations are invalid with `agents-duplicate-observation`.
The API does not choose one based on caller array order. Target paths are
validated, deduplicated only after a duplicate diagnostic, and output in
code-point order.

## Provenance, authority, and enforceability

Every observation has explicit interoperability provenance:

```text
kind: interoperability
source_type: AGENTS.md
source_path: <exact logical path>
source_hash: <exact SHA-256>
scope_root: <logical scope root>
discovery_policy: aira.dev/steering-agents-discovery/v1
```

It is never labeled `project-native-steering` or `aira-template`.

An AGENTS observation has no native authority field, structured rule inventory,
semantic key, override declaration, enforcement binding, or logical Steering
resource identity. Text such as "must", "never", or "required" cannot make it
enforceable. For example, `Workers must never edit .aira/state` remains opaque
guidance; only native typed capability policy can enforce a filesystem denial.
Likewise, 05C-4B1 does not adjudicate an AGENTS sentence allowing direct database
access against a native structured rule requiring a service layer.

The interoperability authority ceiling is fixed now: unstructured AGENTS prose
may never become `enforceable` solely from its wording. Any later use must be an
explicit, versioned 05C-4B2 mapping or import with preserved provenance. Actual
machine enforcement still requires native typed enforcement bindings.

## Freshness comparison

`compareAgentsObservation(reviewed, current)` is pure and returns `match`,
`stale`, or `invalid`. It detects at least:

- exact byte changes;
- source path moves;
- source location identity changes;
- scope-root changes;
- filesystem replacement when filesystem device/inode evidence changes; and
- discovery-policy incompatibility.

Timestamp-only changes do not stale an otherwise identical observed source.
The stable stale condition is represented by `agents-observation-stale` in
higher-level diagnostics; comparison returns deterministic machine-readable
change reasons rather than prose parsing.

## Stable diagnostics

The v1 public issue union includes:

- `agents-source-unsafe`
- `agents-invalid-utf8`
- `agents-file-too-large`
- `agents-aggregate-too-large`
- `agents-file-limit`
- `agents-depth-limit`
- `agents-path-invalid`
- `agents-duplicate-observation`
- `agents-observation-stale`
- `agents-discovery-incomplete`

It also distinguishes project/root input failures, unreadable sources, NUL
content, entry limits, and malformed observations. Diagnostics are deduplicated
and code-point sorted by canonical structured value. Human-facing explanation is
not an API contract.

## Deferred 05C-4B2 and later work

05C-4B2 owns explicit human-reviewed interoperability composition or import,
freshness revalidation before import, any versioned mapping from an AGENTS
source location to a native logical resource identity, authorized inclusion,
provenance transfer, and any interaction with the existing Steering resolver.
It must use the exact observation bytes, hash, path, scope, policy, and
provenance already supplied by 05C-4B1 rather than rediscovering what was
reviewed.

Still deferred are AGENTS publication into a registry, auto-adoption, prose to
rule conversion, native source generation, AGENTS materialization or rewriting,
Context and worker delivery, capability execution, verifier execution,
scheduling, CLI or Pi UX, templates, GC, and Git operations.
