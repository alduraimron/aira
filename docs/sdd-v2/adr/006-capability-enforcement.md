# ADR-006: Deny-wins, fail-closed capability enforcement

Status: accepted. Normative for v2; no sandbox is implemented by this change.

## Context

Context selection and tool-name allowlists do not create an enforceable security boundary. Arbitrary shell with host permissions defeats filesystem capability enforcement, even if Pi intercepts a `tool_call` event before execution.

## Decision

Context is what knowledge Aira deliberately supplies. Capability is what a worker/runtime may do. Context declarations and immutable context snapshots MUST NOT be interpreted as capability grants. Capability policy is provider-neutral, revisioned/identified, and bound to execution inputs and attempts.

Deny wins. Missing enforcement, ambiguous identities, or inability to prove a required hard restriction MUST fail closed. A model promise, prompt instruction, or display warning is not enforcement. Human users alone authorize exceptional escalation; it must be an explicit provenance-bearing policy decision with defined scope, not an implicit grant from a worker request. Authorization still cannot make an incapable backend enforce a hard restriction.

The policy model/compiler must account for filesystem paths, tools, processes, network, environment, and required backend capabilities. Tool names are not sufficient security identities: policy must account for tool provenance and implementation identity/version or integrity identity, with enforcement at the implementation actually dispatched. Replacing a trusted tool with an unrelated implementation under the same name cannot inherit its authority.

Filesystem enforcement uses canonical/resolved execution paths at actual I/O boundaries, for reads and writes, including nonexistent write targets' resolved parents. It must address symlink traversal, rename/creation races, and time-of-check/time-of-use issues through the enforcing tool/backend's guarantees. A pre-tool-call string-prefix check is insufficient and MUST NOT be advertised as confinement. Restricted tool implementations do not confine an unrestricted shell or another bypassing tool.

ExecutionBackend declares at least:

- `filesystem_read_confinement`
- `filesystem_write_confinement`
- `process_confinement`
- `network_confinement`
- `environment_isolation`
- `force_termination`

A policy may require any of these as hard capabilities. Aira MUST check the selected backend's enforceable, configured guarantees before execution and fail closed if they cannot be satisfied. Unsupported requirements MUST NOT silently degrade into prompt advice. Declarations are contracts the adapter must actually enforce, not unverified self-labels. Enforcement failure during execution prevents successful authoritative publication and invokes recovery policy where side effects may be unknown.

## Consequences

Pi-specific hooks remain useful adapter controls but cannot sandbox arbitrary shell semantics, descendants, network, or ambient host permissions on their own. Backend confinement must cover all relevant execution paths, including shell verifiers. Workspace isolation and process sandboxing are related but distinct; a Git worktree is not a sandbox. See [ADR-010](010-workspace-and-execution-backends.md).

Current local execution keeps its existing behavior in this task. It must not be retroactively described as strongly confined. Future strong process termination may require supervision outside a disposable in-process Pi session.

## Invariants

INV-CAP-001, INV-CAP-002, INV-CAP-003, INV-CAP-004, INV-CONTEXT-001, INV-WORKSPACE-002, INV-AGENT-001.
