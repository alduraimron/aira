# Core API

`src/core/index.ts` is Aira's application API. The CLI and Pi extension both use it. Core does not read terminal input, install signal handlers, print output, or choose process exit codes.

## Construction

```ts
import { AiraCore } from "aira/core";
import { PiRuntime } from "aira/agent";

const core = new AiraCore({
  cwd: process.cwd(),
  agentRuntimeFactory: () => new PiRuntime(),
});
```

Core itself depends on the provider-neutral `AgentRuntime` interface. Composition roots provide `PiRuntime`. Tests can provide a fake runtime or executor and do not need a configured model.

Supported dependency seams include the agent runtime factory, existing workflow executor, Git command runner, clock, approval decision applier, and artifact readers.

## Operations

```ts
inspectProject(): Promise<ProjectInfo>
initializeProject(): Promise<ProjectInfo>
listWorkflows(): Promise<WorkflowInfo[]>
previewRun(input: PreviewRunInput): Promise<RunPreview>
startRun(input: StartRunInput, execution?: CoreExecutionOptions): Promise<RunBoundary>
inspectRun(runId?: string): Promise<RunView | undefined>
continueRun(input: ContinueRunInput, execution?: CoreExecutionOptions): Promise<RunBoundary>
readArtifact(input: ReadArtifactInput): Promise<ArtifactView>
```

`inspectProject`, `listWorkflows`, `previewRun`, `inspectRun`, and `readArtifact` are read-only.

`previewRun` loads and validates the project config, named workflow, command files, and effective agent settings. It does not inspect Git, create a run, construct an agent runtime, execute shell commands, or write artifacts. Its `preparationToken` identifies the prepared workflow, config, command prompts, and resolved agent settings.

`startRun` repeats preparation against current files, applies the dirty-worktree policy, creates a run, and invokes the existing executor until a lifecycle boundary. A frontend that showed a preview to a human can pass its token as `expectedPreparationToken`. Core refuses the start if relevant files changed before the authorized call.

`continueRun` accepts:

```ts
{ runId, action: "approve" }
{ runId, action: "revise", feedback }
{ runId, action: "cancel" }
{ runId, action: "resume" }
```

Core reloads authoritative state by run ID and validates the action. Boundaries and run views include a `checkpointToken`. Interactive frontends pass it as `expectedBoundaryToken`, so Core refuses an approval, revision, cancellation, or resume if the run changed while the human was deciding. Revision calls Aira's existing approval decision code. It records the exact previous artifact path, resets the configured replay range, persists feedback, executes the target in a fresh worker session, writes the next artifact version, and resolves the durable revision record after success.

`inspectRun()` without an ID uses Aira's newest run ID. It returns `undefined` when no runs exist. An explicit missing run throws `CoreRunNotFoundError`.

`readArtifact` accepts a current artifact name, one-based known version, or exact run-relative path already present in that artifact's persisted history. It never accepts arbitrary filesystem paths.

## Execution options

```ts
interface CoreExecutionOptions {
  signal?: AbortSignal;
  onEvent?: ExecutionEventListener;
}
```

Core passes these values to `executeWorkflow`. Aira's executor remains the only workflow state machine. Event callbacks receive Aira's existing sanitized operator-visible events. Callback failures remain best-effort and cannot change execution.

A caller abort reaches the active worker Pi or shell command. The executor persists the existing interrupted state and returns an `interrupted` boundary when cancellation settles normally.

## Boundaries

`RunBoundary` is a discriminated union:

```ts
type RunBoundary =
  | CompletedBoundary
  | ApprovalRequiredBoundary
  | InterruptedBoundary
  | FailedBoundary
  | CancelledBoundary
  | ManualInterventionBoundary;
```

Every boundary includes the run ID, workflow, status, concise summary, allowed actions, current step when applicable, and artifact metadata.

An approval boundary also includes its message, allowed decisions, revision target when configured, and referenced artifact content when available. Consumers do not parse CLI text.

An interrupted boundary states whether resume validated against the current workflow.

A manual-intervention boundary currently represents exhausted loops and incompatible waiting states. Its `supported` field is false. Core does not invent loop recovery.

`RunView` is the status DTO. It includes step views, artifact metadata, a pending revision summary when present, resume eligibility, allowed actions, and a boundary for non-running states. It is not `RunState` and cannot be persisted back into Aira.

## Errors

Application policy and usage errors extend `AiraCoreError` and expose a stable `code`, operation, and relevant run, workflow, or step IDs. Important classes include:

- `ProjectNotInitializedError`
- `CoreWorkflowNotFoundError`
- `CoreRunNotFoundError`
- `InvalidRunInputError`
- `StaleRunPreparationError`
- `StaleRunBoundaryError`
- `DirtyWorktreeError`
- `InvalidLifecycleActionError`
- `InvalidRevisionFeedbackError`
- `IncompatibleRunStateError`
- `MissingRuntimeDependencyError`
- `CoreExecutionError`

Existing typed validation and infrastructure errors remain available from `aira/core` for project initialization, config, workflow, command files, execution, Git, artifacts, approval decisions, agent runtime failures, and persisted run state. Unexpected causes are retained through `Error.cause` rather than converted to strings.

A normal nonzero top-level shell result returns a `failed` boundary. A technical executor failure that persisted a failed run throws `CoreExecutionError` with `persisted: true`. This keeps lifecycle outcomes separate from infrastructure or invalid-execution failures.
