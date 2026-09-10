# ADR-010: Provider-neutral workspaces and execution backends

Status: accepted. Normative for v2; exact fingerprint and sandbox implementations are deferred.

## Context

A directory path or `git status --porcelain` does not identify repository content sufficiently for evidence. A separate worktree isolates files but does not inherently confine processes, network, environment, or access to the host.

## Decision

`WorkspaceHandle` identifies the workspace, provider, repository/project association, and provider-specific location/reference through provider-neutral contracts. It carries or resolves capabilities and the means to observe a fingerprint; domain code does not depend on Git commands, OS paths, container APIs, or Pi SDK types.

`WorkspaceFingerprint` is an immutable, versioned identity of observed workspace state, with fingerprint algorithm/policy identity, workspace/provider identity, and a digest over canonically identified relevant content/state. Equivalent observations under the same contract must be stable; changes within its declared scope must be detectable. The schema supports provider-specific structured components without requiring every provider to pretend to be Git.

For a Git workspace it must be capable of identifying:

- repository identity (not just a relocatable directory name);
- base commit;
- index/tree state as needed, including staged versus working-tree differences;
- tracked diff identity, including relevant content, modes, deletions, and renames;
- untracked file identities and content hashes according to explicit policy;
- workspace provider identity and relevant workspace instance identity.

Capture/exclusion policy must be explicit and revisioned, including treatment of ignored files, submodules, symlinks, generated outputs, and Aira's own storage/views as applicable. An exclusion cannot silently omit an input required by verification. `git status --porcelain` alone is insufficient: the same status labels can describe different file bytes. File timestamps alone are likewise insufficient. Exact encoding, race-resistant observation, and Git/non-Git algorithms are deferred; the binding must already be representable in the first schema.

Attempts and evidence bind this fingerprint. Initially evidence uses conservative exact applicability: any fingerprint change after verification makes that evidence historical, not applicable to the new current state. Providers/runners must establish and check the observation boundary, including concurrent writes; store HEAD locking does not by itself freeze workspace files. Future scoped applicability must not rewrite historical evidence identities.

### ExecutionBackend contract

The execution backend is separately identified and advertises enforceable configured capabilities, at least:

| Capability | Guarantee the policy may require |
| --- | --- |
| `filesystem_read_confinement` | Reads confined to authorized resources across all permitted execution paths |
| `filesystem_write_confinement` | Writes confined to authorized resources across all permitted execution paths |
| `process_confinement` | Process/descendant access and escape restricted to the declared boundary |
| `network_confinement` | Network access restricted to declared policy |
| `environment_isolation` | Environment/credentials/ambient configuration isolated as declared |
| `force_termination` | Supervised work, including required descendants, can be forcibly stopped within the declared boundary |

Required hard capability mismatch MUST cause Aira to fail closed before dispatch. Do not silently turn a hard restriction into prompt advice. Pi `tool_call` interception alone cannot enforce shell semantics; arbitrary shell with host permissions defeats filesystem confinement. Canonical/resolved path enforcement belongs at actual I/O boundaries and/or the enforcing backend, not just a string-prefix hook.

The architecture may support current/local workspace execution, sandboxed local execution, Git worktree workspaces, and container backends. Workspace providers and execution backends compose only when their capabilities/identities satisfy policy. A worktree is not automatically a sandbox; a container label alone does not prove its configured capabilities either.

Current Aira worker attempts create fresh disposable Pi in-memory sessions, not necessarily fresh OS processes. Provider/model abstraction remains behind AgentRuntime; Spec Core has no Pi SDK dependency. Strong process termination may require a supervised execution backend outside the in-process session boundary. Current local execution must advertise only guarantees it actually provides, not future sandbox guarantees.

## Consequences

No sandbox, fingerprint algorithm, worktree provider, or container runner is implemented in this task. The first v2 schema still includes workspace/provider/backend identities and capability requirements so future providers and parallel scheduling do not reinterpret old attempts or evidence.

## Invariants

INV-WORKSPACE-001, INV-WORKSPACE-002, INV-CAP-001, INV-CAP-004, INV-EVIDENCE-001, INV-AGENT-001.
