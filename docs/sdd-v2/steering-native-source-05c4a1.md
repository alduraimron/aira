# Steering 05C-4A1: native project source inspection

Status: implemented. This document defines the read-only native authoring adapter
for the [Project Steering contract](steering-contract.md). The authoritative
[registry store](steering-store-05c3b1.md), immutable snapshot store, resolver,
and snapshots retain their existing meanings.

05C-4A1 answers one question:

> What exact native Steering source files exist, and what resource semantics do
> those exact bytes propose?

It does not adopt, publish, resolve, materialize, or compare those proposals with
the authoritative registry.

## Authority boundary

Native files under `.aira/steering/**` are authoring inputs. They are not
Steering authority. Editing, moving, copying, or deleting one of these files does
not mutate `.aira/state/v2/steering/`, publish a body blob, replace Steering HEAD,
or advance `SteeringGeneration`.

The flow is intentionally split:

```text
.aira/steering source bytes
  -> 05C-4A1 bounded discovery and parsing
  -> exact source observation plus project proposal
  -> 05C-4A2 explicit authorized adoption and CAS publication
  -> authoritative registry
  -> 05C-2 resolution
  -> 05C-3A snapshot
```

A proposal has no `SteeringRevisionId`, `created` metadata, `supersedes`
selection, registry expectation, or publication operation. Those are
publication-owned inputs in 05C-4A2.

## Native authoring surface

The only recognized source root is the literal project-relative path:

```text
.aira/steering
```

An inspector receives an explicit absolute canonical trusted project root and a
validated project/control identity. It never searches parents and never derives
a project root from process cwd.

The conventional standard layout is:

```text
.aira/steering/
  product.md
  architecture.md
  technology.md
  structure.md
  engineering.md
  testing.md
  security.md
  operations.md
  custom/
    <bounded subdirectories>/<resource>.md
```

None of the eight standard files is required by discovery. Future project,
profile, or release policy can define requiredness.

A standard source can use any root-level `.md` filename. The eight conventional
filenames are ergonomic recommendations, not identity. If one of those names
contains another structured ID, inspection returns
`steering-source-conventional-name-mismatch` as a warning and retains the
frontmatter ID. It never silently renames the resource.

The `custom/` subtree is the recommended organization for additional resources
and is the only recursively scanned subtree. Bounded nested directories are
supported, so custom content does not require one flat physical layout. Physical
placement does not assign semantic kind: a custom-kind document may also be a
root-level source, and a standard-kind document may be organized under
`custom/`. In every case, kind and logical ID come only from metadata. This also
allows duplicate IDs across root and custom sources to be diagnosed rather than
silently interpreted as different resources.

## Source format

The source schema is:

```text
aira.dev/steering-source/v1
```

A file is strict UTF-8 Markdown framed by one YAML 1.2 frontmatter document:

```markdown
---
aira:
  schema: aira.dev/steering-source/v1
  id: steering.architecture
  kind: architecture
  layer: project-root
  provenance:
    authorship: authored
  authority: normative
  override_policy: narrower-scope
  enforcement: []
  inclusion:
    availability: required
    selector:
      kind: always
  scope:
    kind: project-global
  rules:
    - id: rule.architecture.repository-access
      title: Use repository boundaries
      authority: normative
      semantics:
        key: topic.architecture.data-access
        effect: require
        value: repository-layer
      override_policy: narrower-scope
      status: active
      rationale: Keep transport and persistence boundaries separate.
      enforcement: []
      source:
        location:
          kind: document
  composition:
    parents: []
    overrides: []
  compatibility:
    resolver: aira.dev/steering-resolution/v1
    required_schemas: []
  title: Architecture constitution
  labels:
    - architecture
  behavioral_assets: []
---
# Architecture

Project architecture guidance.
```

All fields shown are explicit. The source adapter does not inject mutable
project defaults. Frontmatter fields map to the existing pure Steering resource
contract as follows:

| Source field | Proposed domain field |
| --- | --- |
| `id` | logical `SteeringResourceId` |
| `kind`, `custom_kind` | existing resource kind and custom category |
| `layer` | `project-root` or `project-scoped` |
| `provenance` | project authorship and optional exact adoption attribution |
| `authority` | `default_authority` |
| `override_policy` | `default_override_policy` |
| `enforcement` | `default_enforcement` |
| `inclusion`, `scope` | existing inclusion and scope value objects |
| `rules` | existing `SteeringRule` values |
| `composition`, `compatibility` | existing value objects |
| title, description, labels | existing resource metadata |
| `behavioral_assets` | existing exact behavioral attribution |

Revision identity, publication creation metadata, and predecessor selection are
not legal source fields. Unknown fields fail, including misspellings such as
`autority`.

## YAML safety

The parser uses the repository's existing `yaml` dependency in strict YAML 1.2
core mode. It requires unique string mapping keys and rejects:

- duplicate keys;
- multiple YAML documents;
- aliases and anchors;
- merge behavior;
- custom or unresolved tags;
- unknown source-schema fields;
- metadata beyond the policy node and depth bounds.

YAML is decoded only after the complete source passes the file-size and strict
UTF-8 checks. No executable tag or arbitrary object construction mechanism is
enabled.

## Frontmatter and body split

The file must begin at byte zero with an exact `---` delimiter line. UTF-8 BOMs
and NUL bytes are rejected. Opening and closing delimiter lines may independently
use LF or CRLF. A delimiter is recognized only when the complete line is exactly
three ASCII hyphens.

The frontmatter byte range starts after the opening delimiter terminator and ends
before the closing delimiter line. Body bytes start immediately after the
closing delimiter terminator. If the closing delimiter is the final line without
a terminator, the body is empty.

Delimiter bytes and frontmatter bytes are part of complete source bytes but are
not part of body bytes. No leading blank line is removed. No trailing newline is
added or removed.

## Exact bytes and hashes

The adapter retains two independent exact identities:

1. complete source bytes, including delimiters and YAML;
2. exact body bytes after framing.

Both use the shared lowercase SHA-256 `hashBytes` primitive. Body content is
proposed with:

```text
content_encoding: aira.dev/steering-bytes/raw/v1
media_type: text/markdown; charset=utf-8
```

There is no LF/CRLF conversion, Unicode normalization, trimming, whitespace
folding, code-block processing, or Markdown rendering transformation. A trailing
newline, one space, a frontmatter comment, or a delimiter line-ending change
changes the complete source hash. A body whitespace or line-ending change also
changes the exact body hash. The proposed body hash is therefore the hash that a
future `SteeringResourceRevision.content.hash` must use.

A third hash covers the validated structured source metadata encoded with
`aira.dev/canonical-json/v1`. This semantic metadata hash excludes prose body
bytes and lets adoption preflight distinguish a metadata change from a body-only
change. It is not a replacement for either exact byte hash.

## Logical identity

`SteeringResourceId` comes only from `aira.id`. It does not come from the
filename, directory, heading, title, or enumeration order.

Moving a file does not change its resource ID. Copying one file does not create a
new resource. If two valid sources declare the same logical ID, inspection emits
`steering-source-duplicate-resource-id`, lists every path in code-point order,
and excludes all colliding proposals from the adoption-eligible proposal list.
The individually parsed values remain available in the invalid-source records
for review.

## Structured rules and prose

Rules use the existing `SteeringRule` identities, semantic keys, effects, values,
authority, scope, inclusion, override policy, enforcement bindings, status, and
rationale contracts. The adapter does not define another rule model and does not
infer rules from Markdown.

A source location declares only the existing location value. Its body hash is
derived by the adapter and inserted into the proposed `SteeringRule.source`.
Line ranges must be inside the exact body. The exact body hash prevents a source
location from being carried to changed prose without detection.

Document authority is only a default. It does not make arbitrary prose machine
enforceable. Enforceable rules still require an existing recognized required
binding. An enforceable document default must also be represented by an active
structured enforceable rule that retains each required default binding. Text
such as "the agent MUST obey" has no enforcement meaning by itself.

## Source provenance

Every native source observation has:

```text
kind: native-project-source
project: <trusted project/control identity>
authorship: authored | adopted
```

An adopted source also carries the existing exact `SteeringSourceReference`.
The corresponding proposal always uses `kind: project` provenance. A source may
therefore preserve attribution to an exact Aira template revision or imported
source without claiming template or import authority itself.

Editing adopted project bytes keeps project provenance and the historical
attribution edge. It cannot relabel the edited file as an unchanged
`aira-template` asset. Publication authenticity and source-catalog verification
remain 05C-4A2 responsibilities.

Source provenance is observation provenance. It is not proof that any revision
has been adopted or published.

## Source observation contract

`aira.dev/steering-source-observation/v1` records:

- source schema and discovery policy;
- project/control identity;
- literal project-relative source path;
- logical resource ID, kind, and custom kind;
- exact complete source hash and byte count;
- exact body hash and byte count;
- structured metadata semantic hash;
- native source provenance;
- filesystem device, inode, link count, mode, size, mtime, and ctime observations
  when read from the filesystem.

Direct in-memory parsing uses an explicit detached filesystem observation. The
filesystem inspector always produces the full filesystem form. Device and inode
are diagnostic replacement identity, not logical resource identity. mtime and
ctime are diagnostic only and are not content identity.

The successful parse result also returns independent copies of complete source
bytes and exact body bytes. A future adopter must verify those bytes against the
observation again before publication.

## Discovery policy

The fixed policy is:

```text
aira.dev/steering-discovery/native/v1
```

| Property | v1 value |
| --- | --- |
| root | `.aira/steering` only |
| source extension | lowercase `.md` only |
| standard recursion | none, root files only |
| custom recursion | `custom/`, at most 4 nested directories |
| maximum recognized files | 256 |
| maximum file bytes | 1,048,576 |
| maximum aggregate source bytes | 8,388,608 |
| maximum rules per source | 256 |
| maximum frontmatter bytes | 262,144 |
| maximum metadata depth/nodes | 48 / 100,000 |
| directory entries | 1,024 per directory, 4,096 total |
| ordering | resource ID, then logical path, in code-point order |

Editor temporaries ending in `~`, `.swp`, `.swo`, `.tmp`, `.temp`, or `.bak`,
Emacs lock/backup names, and `.DS_Store` are ignored. `AGENTS.md` is also ignored
without reading or parsing because 05C-4B owns that source. Unsupported regular
extensions and unrecognized root directories produce warnings and are not read.
The adapter never recursively explores an unrecognized directory.

Count or aggregate overflow fails the inspection closed before source reads.
Individual oversize files are not opened. Output order never uses directory
entry order, inode, mtime, or creation order.

## Path, symlink, and race behavior

The trusted project root must already exist, be absolute, canonical, and free of
symlinks. Inspection performs no mkdir or other mutation. It rejects or reports:

- a symlinked project, `.aira`, or Steering root;
- symlinked files;
- directory symlinks in the scanned source surface;
- logical traversal, absolute paths, backslashes, control characters, and
  unsupported recursion;
- regular files with link count other than one;
- cross-device directories or files below the trusted project root;
- devices, FIFOs, sockets, and other non-regular entries;
- source substitution or mutation detected between `lstat`, no-follow open,
  bounded read, handle stat, pathname recheck, and final stat.

Reads use `O_NOFOLLOW`, `O_NONBLOCK`, exact inode checks, and a fixed-size bounded
buffer. Directory observations are checked before and after enumeration and
rechecked before the inspection returns. The implementation follows the same
fail-closed principles as the storage and legacy
safe readers, while remaining read-only and avoiding storage initialization.

Node pathname APIs do not provide race-free `openat` confinement. An owner able
to replace trusted ancestors concurrently may still win a swap-and-restore race
between pathname checks. Same-device bind mounts are not portably identifiable
with these Node primitives. The control root must therefore remain unavailable
to untrusted workers. This adapter does not claim sandboxing or protection from
the trusted control-root owner.

## Mutation comparison

`compareSteeringSourceObservations(reviewed, current)` is a pure comparison for
the later adoption preflight. Native v1 requires equality of:

- discovery and source contracts;
- project/control identity;
- project-relative source path;
- complete source hash and size;
- body hash and size;
- parsed logical identity;
- structured metadata hash;
- source provenance;
- filesystem device and inode when both observations came from the filesystem.

Any exact byte change is stale, including whitespace. Moving the source is stale
for the reviewed proposal even though its logical resource ID is unchanged.
Replacing the pathname with a new inode containing identical bytes is also stale.
A timestamp-only change with identical bytes and the same opened file identity is
not stale because mtime is not content identity.

## Read-only inspection API

```ts
inspectNativeSteering(projectRoot, { project })
```

returns deterministic:

- discovery policy and project/control identity;
- root status and completeness;
- exact discovered file observations;
- unambiguous individually valid proposals with exact bytes;
- invalid source diagnostics;
- duplicate logical identity groups;
- unsafe path diagnostics;
- warnings.

A later adopter must require inspection status `valid`; it cannot consume a
partial proposal list from an invalid or incomplete inspection.

The API does not accept a `SteeringStore`, `BlobStore`, resolver, Context runtime,
worker, CLI, or Pi object. It does not inspect current registry state and does not
classify proposals as new, changed, unchanged, or retired.

## Deferred work

05C-4A2 owns explicit adoption and publication, including authorization,
reinspection, stale-proposal rejection, revision allocation, predecessor and
registry comparison, operation identity, expected HEAD/resource CAS, source
catalog authentication, body publication, and registry commit.

05C-4A2 also owns materialization and any explicit registry-to-file operation.
No source directory or placeholder content is generated here.

05C-4B owns `AGENTS.md` discovery and interoperability semantics. Later Context
and worker stages own resolved Steering delivery. Capability runtime, verifier
execution, scheduler integration, CLI/Pi UX, production built-in templates, GC,
and Git operations remain outside 05C-4A1.
