import { createHash } from "node:crypto";
import path from "node:path";

import type { AgentRuntime } from "../agent/runtime";
import {
  applyApprovalDecision,
  type ApprovalDecision,
} from "../approval";
import {
  ArtifactVersionNotFoundError,
  readArtifact,
  readArtifactVersion,
} from "../artifacts";
import { loadConfig, type AiraConfig } from "../config";
import {
  executeWorkflow,
  ExecutionError,
  preflightWorkflow,
  prepareRunForResume,
  type ExecutionMode,
  type WorkflowPreflightResult,
} from "../executor";
import { inspectGitWorkingTree } from "../git";
import { sanitizeDisplayText } from "../observability/display";
import {
  findAiraProjectRoot,
  getAiraProjectPaths,
  initializeAiraProject,
  type AiraProjectPaths,
} from "../project";
import {
  createRun,
  findLatestRunId,
  getPendingRevision,
  isPendingRevisionResumeState,
  loadRun,
  RunNotFoundError,
  type ArtifactState,
  type RunState,
} from "../run";
import {
  findWorkflowStep,
  flattenWorkflowSteps,
  loadNamedWorkflow,
  loadWorkflowCatalog,
  WorkflowNotFoundError,
  type Workflow,
  type WorkflowStep,
} from "../workflow";
import type {
  AiraCoreDependencies,
  CoreWorkflowExecutor,
} from "./dependencies";
import {
  CoreExecutionError,
  CoreRunNotFoundError,
  CoreWorkflowNotFoundError,
  DirtyWorktreeError,
  IncompatibleRunStateError,
  InvalidLifecycleActionError,
  InvalidRevisionFeedbackError,
  InvalidRunInputError,
  MissingRuntimeDependencyError,
  ProjectNotInitializedError,
  StaleRunBoundaryError,
  StaleRunPreparationError,
} from "./errors";
import type {
  ArtifactMetadata,
  ArtifactVersionMetadata,
  ArtifactView,
  BoundaryStep,
  ContinueRunInput,
  CoreExecutionOptions,
  PendingRevisionView,
  PreviewAgentConfiguration,
  PreviewRunInput,
  ProjectInfo,
  ReadArtifactInput,
  RunAction,
  RunBoundary,
  RunPreview,
  RunPreviewStep,
  RunStepType,
  RunStepView,
  RunView,
  StartRunInput,
  WorkflowInfo,
} from "./types";

interface PreparedWorkflow {
  paths: AiraProjectPaths;
  config: AiraConfig;
  workflow: Workflow;
  preflight: WorkflowPreflightResult;
}

export interface AiraCoreOptions extends AiraCoreDependencies {
  cwd: string;
}

const systemClock = () => new Date();

export class AiraCore {
  readonly cwd: string;

  private readonly agentRuntimeFactory?: () => AgentRuntime;
  private readonly executor: CoreWorkflowExecutor;
  private readonly gitCommandRunner?: AiraCoreDependencies["gitCommandRunner"];
  private readonly clock: () => Date;
  private readonly approvalDecisionApplier: typeof applyApprovalDecision;
  private readonly artifactReader: typeof readArtifact;
  private readonly artifactVersionReader: typeof readArtifactVersion;

  constructor(options: AiraCoreOptions) {
    this.cwd = path.resolve(options.cwd);
    this.agentRuntimeFactory = options.agentRuntimeFactory;
    this.executor = options.executor ?? executeWorkflow;
    this.gitCommandRunner = options.gitCommandRunner;
    this.clock = options.clock ?? systemClock;
    this.approvalDecisionApplier =
      options.approvalDecisionApplier ?? applyApprovalDecision;
    this.artifactReader = options.artifactReader ?? readArtifact;
    this.artifactVersionReader =
      options.artifactVersionReader ?? readArtifactVersion;
  }

  async inspectProject(): Promise<ProjectInfo> {
    const root = await findAiraProjectRoot(this.cwd);

    if (root === undefined) {
      return { initialized: false, root: this.cwd };
    }

    const paths = getAiraProjectPaths(root);
    return {
      initialized: true,
      root: paths.root,
      airaDirectory: paths.airaDir,
    };
  }

  async initializeProject(): Promise<ProjectInfo> {
    const result = await initializeAiraProject(this.cwd);
    return {
      initialized: true,
      root: result.paths.root,
      airaDirectory: result.paths.airaDir,
      created: result.created,
    };
  }

  async listWorkflows(): Promise<WorkflowInfo[]> {
    const paths = await this.requireProject("listWorkflows");
    const catalog = await loadWorkflowCatalog(paths.workflowsDir);
    return catalog.map(({ workflow }) => toWorkflowInfo(workflow));
  }

  async previewRun(input: PreviewRunInput): Promise<RunPreview> {
    validateTask(input.task, "previewRun", input.workflow);
    const prepared = await this.prepareWorkflow(input.workflow, "previewRun");

    return {
      projectRoot: prepared.paths.root,
      preparationToken: getPreparationToken(prepared),
      workflow: toWorkflowInfo(prepared.workflow),
      task: input.task,
      steps: prepared.workflow.steps.map((step) =>
        toPreviewStep(step, prepared.preflight),
      ),
      hasAgentSteps: prepared.preflight.agentSteps.size > 0,
    };
  }

  async startRun(
    input: StartRunInput,
    execution: CoreExecutionOptions = {},
  ): Promise<RunBoundary> {
    validateTask(input.task, "startRun", input.workflow);
    const prepared = await this.prepareWorkflow(input.workflow, "startRun");

    if (
      input.expectedPreparationToken !== undefined &&
      input.expectedPreparationToken !== getPreparationToken(prepared)
    ) {
      throw new StaleRunPreparationError(prepared.workflow.name);
    }

    if (input.allowDirty !== true) {
      const git = await inspectGitWorkingTree(
        prepared.paths.root,
        this.gitCommandRunner,
      );

      if (git.dirty) {
        throw new DirtyWorktreeError(prepared.paths.root);
      }
    }

    const agentRuntime = this.createAgentRuntime(prepared, "startRun");
    const state = await createRun({
      runsRoot: prepared.paths.runsDir,
      workflow: prepared.workflow.name,
      input: { task: input.task },
      stepIds: flattenWorkflowSteps(prepared.workflow).map((step) => step.id),
      now: this.readClock("startRun"),
    });

    return await this.executePrepared(
      prepared,
      state,
      "fresh",
      agentRuntime,
      execution,
    );
  }

  async inspectRun(runId?: string): Promise<RunView | undefined> {
    const paths = await this.requireProject("inspectRun");
    const selectedRunId = runId ?? (await findLatestRunId(paths.runsDir));

    if (selectedRunId === undefined) {
      return undefined;
    }

    const state = await this.loadRun(paths, selectedRunId, "inspectRun");
    const inspectedWorkflow = await loadWorkflowForInspection(
      paths,
      state.workflow,
    );
    return await this.toRunView(
      paths,
      state,
      inspectedWorkflow.workflow,
      inspectedWorkflow.issue,
    );
  }

  async continueRun(
    input: ContinueRunInput,
    execution: CoreExecutionOptions = {},
  ): Promise<RunBoundary> {
    const paths = await this.requireProject("continueRun");
    const state = await this.loadRun(paths, input.runId, "continueRun");

    if (input.action === "resume") {
      this.assertResumeStatusAllowed(state);
    }

    const prepared = await this.prepareWorkflowFromPaths(
      paths,
      state.workflow,
      "continueRun",
    );

    if (input.action === "resume") {
      if (
        input.expectedBoundaryToken !== undefined &&
        input.expectedBoundaryToken !==
          getRunCheckpointToken(state, { workflow: prepared.workflow })
      ) {
        throw new StaleRunBoundaryError(state.id);
      }

      this.assertResumeAllowed(prepared.workflow, state);
      const agentRuntime = this.createAgentRuntime(
        prepared,
        "continueRun",
        state,
      );
      return await this.executePrepared(
        prepared,
        state,
        "resume",
        agentRuntime,
        execution,
      );
    }

    const boundary = await this.toBoundary(paths, state, prepared.workflow);

    if (
      input.expectedBoundaryToken !== undefined &&
      input.expectedBoundaryToken !== boundary.checkpointToken
    ) {
      throw new StaleRunBoundaryError(state.id);
    }

    if (boundary.kind !== "approval-required") {
      throw invalidDecisionForBoundary(input.action, boundary);
    }

    if (!boundary.allowedActions.includes(input.action)) {
      throw new InvalidLifecycleActionError({
        runId: state.id,
        action: input.action,
        stepId: boundary.approval.stepId,
        allowedActions: boundary.allowedActions,
        message:
          `run "${state.id}" does not allow action "${input.action}" at ` +
          `approval "${boundary.approval.stepId}"`,
      });
    }

    if (
      input.action === "revise" &&
      (typeof input.feedback !== "string" || input.feedback.trim().length === 0)
    ) {
      throw new InvalidRevisionFeedbackError(state.id);
    }

    const agentRuntime =
      input.action === "cancel"
        ? undefined
        : this.createAgentRuntime(
            prepared,
            "continueRun",
            state,
            input.action === "revise",
          );
    const decision = input.action as ApprovalDecision;
    const decided = await this.approvalDecisionApplier({
      workflow: prepared.workflow,
      runsRoot: paths.runsDir,
      state,
      stepId: boundary.approval.stepId,
      decision,
      ...(input.action === "revise" ? { feedback: input.feedback } : {}),
      now: this.clock,
    });

    if (input.action === "cancel") {
      return await this.toBoundary(paths, decided, prepared.workflow);
    }

    if (decided.status !== "running") {
      throw new IncompatibleRunStateError({
        operation: "continueRun",
        runId: decided.id,
        workflow: decided.workflow,
        stepId: boundary.approval.stepId,
        message:
          `approval action "${input.action}" returned run ` +
          `"${decided.id}" with status "${decided.status}"`,
      });
    }

    return await this.executePrepared(
      prepared,
      decided,
      "continue",
      agentRuntime,
      execution,
    );
  }

  async readArtifact(input: ReadArtifactInput): Promise<ArtifactView> {
    const paths = await this.requireProject("readArtifact");
    const state = await this.loadRun(paths, input.runId, "readArtifact");

    if (input.path !== undefined && input.version !== undefined) {
      throw new InvalidRunInputError(
        "readArtifact accepts either path or version, not both",
        "readArtifact",
        state.workflow,
      );
    }

    const artifact = getOwnArtifact(state, input.name);
    let selectedPath = artifact?.current;

    if (input.version !== undefined) {
      if (!Number.isInteger(input.version) || input.version < 1) {
        throw new InvalidRunInputError(
          "artifact version must be a positive integer",
          "readArtifact",
          state.workflow,
        );
      }

      const knownPaths = artifact?.versions ??
        (artifact === undefined ? [] : [artifact.current]);
      selectedPath = knownPaths[input.version - 1];

      if (selectedPath === undefined) {
        throw new ArtifactVersionNotFoundError(
          state.id,
          input.name,
          `version:${input.version}`,
        );
      }
    } else if (input.path !== undefined) {
      selectedPath = input.path;
    }

    const content =
      input.path !== undefined || input.version !== undefined
        ? await this.artifactVersionReader({
            runsRoot: paths.runsDir,
            state,
            name: input.name,
            path: selectedPath ?? "",
          })
        : await this.artifactReader({
            runsRoot: paths.runsDir,
            state,
            name: input.name,
          });
    const resolvedArtifact = getOwnArtifact(state, input.name);

    if (resolvedArtifact === undefined || selectedPath === undefined) {
      throw new IncompatibleRunStateError({
        operation: "readArtifact",
        runId: state.id,
        workflow: state.workflow,
        message: `artifact "${input.name}" is missing from run state`,
      });
    }

    const versions = toArtifactVersions(resolvedArtifact);
    const selectedVersion = versions.find(
      (candidate) => candidate.path === selectedPath,
    );

    return {
      runId: state.id,
      workflow: state.workflow,
      name: input.name,
      path: selectedPath,
      content,
      byteLength: Buffer.byteLength(content, "utf8"),
      lineCount: countLines(content),
      isCurrent: selectedPath === resolvedArtifact.current,
      versioned: resolvedArtifact.versions !== undefined,
      ...(selectedVersion?.version === undefined
        ? {}
        : { version: selectedVersion.version }),
      versions,
    };
  }

  private async requireProject(operation: string): Promise<AiraProjectPaths> {
    const root = await findAiraProjectRoot(this.cwd);

    if (root === undefined) {
      throw new ProjectNotInitializedError(this.cwd, operation);
    }

    return getAiraProjectPaths(root);
  }

  private async prepareWorkflow(
    workflowName: string,
    operation: string,
  ): Promise<PreparedWorkflow> {
    const paths = await this.requireProject(operation);
    return await this.prepareWorkflowFromPaths(paths, workflowName, operation);
  }

  private async prepareWorkflowFromPaths(
    paths: AiraProjectPaths,
    workflowName: string,
    operation: string,
  ): Promise<PreparedWorkflow> {
    const config = await loadConfig(paths.configFile);
    let workflow: Workflow;

    try {
      workflow = (await loadNamedWorkflow(paths.workflowsDir, workflowName)).workflow;
    } catch (cause) {
      if (cause instanceof WorkflowNotFoundError) {
        throw new CoreWorkflowNotFoundError(workflowName, operation, cause);
      }

      throw cause;
    }

    const preflight = await preflightWorkflow({
      workflow,
      config,
      commandsDir: paths.commandsDir,
    });
    return { paths, config, workflow, preflight };
  }

  private createAgentRuntime(
    prepared: PreparedWorkflow,
    operation: string,
    state?: RunState,
    force = false,
  ): AgentRuntime | undefined {
    const requiresRuntime =
      force ||
      (state === undefined
        ? prepared.preflight.agentSteps.size > 0
        : [...prepared.preflight.agentSteps.keys()].some((stepId) => {
            const status = state.steps[stepId]?.status;
            return status !== "completed" && status !== "skipped";
          }));

    if (!requiresRuntime) {
      return undefined;
    }

    if (this.agentRuntimeFactory === undefined) {
      throw new MissingRuntimeDependencyError(
        prepared.workflow.name,
        operation,
      );
    }

    return this.agentRuntimeFactory();
  }

  private async executePrepared(
    prepared: PreparedWorkflow,
    state: RunState,
    mode: ExecutionMode,
    agentRuntime: AgentRuntime | undefined,
    execution: CoreExecutionOptions,
  ): Promise<RunBoundary> {
    let nextState: RunState;

    try {
      nextState = await this.executor({
        workflow: prepared.workflow,
        runsRoot: prepared.paths.runsDir,
        state,
        context: { config: prepared.config },
        cwd: prepared.paths.root,
        commandsDir: prepared.paths.commandsDir,
        shellTimeout: prepared.config.defaults?.shell_timeout,
        agentRuntime,
        signal: execution.signal,
        mode,
        now: this.clock,
        onEvent: execution.onEvent,
      });
    } catch (cause) {
      if (!(cause instanceof ExecutionError)) {
        throw cause;
      }

      let persisted = false;

      try {
        persisted =
          (await loadRun(prepared.paths.runsDir, state.id)).status === "failed";
      } catch {
        persisted = false;
      }

      throw new CoreExecutionError({
        runId: state.id,
        stepId: cause.stepId,
        message: cause.message,
        cause,
        persisted,
      });
    }

    if (
      nextState.id !== state.id ||
      nextState.workflow !== prepared.workflow.name
    ) {
      throw new IncompatibleRunStateError({
        operation: "execute",
        runId: state.id,
        workflow: prepared.workflow.name,
        message:
          `executor returned incompatible state for run "${state.id}" ` +
          `and workflow "${prepared.workflow.name}"`,
      });
    }

    return await this.toBoundary(
      prepared.paths,
      nextState,
      prepared.workflow,
    );
  }

  private assertResumeStatusAllowed(state: RunState): void {
    if (state.status === "interrupted" || isPendingRevisionResumeState(state)) {
      return;
    }

    if (state.status === "running") {
      throw new InvalidLifecycleActionError({
        runId: state.id,
        action: "resume",
        message:
          `run "${state.id}" is "running"; automatic crash recovery ` +
          "is not implemented",
      });
    }

    throw new InvalidLifecycleActionError({
      runId: state.id,
      action: "resume",
      message: `run "${state.id}" is "${state.status}" and cannot be resumed`,
    });
  }

  private assertResumeAllowed(workflow: Workflow, state: RunState): void {
    try {
      prepareRunForResume(workflow, state);
    } catch (cause) {
      throw new IncompatibleRunStateError({
        operation: "continueRun",
        runId: state.id,
        workflow: state.workflow,
        stepId: state.current_step,
        message:
          `run "${state.id}" cannot be resumed: ${getErrorMessage(cause)}`,
        cause,
      });
    }
  }

  private async loadRun(
    paths: AiraProjectPaths,
    runId: string,
    operation: string,
  ): Promise<RunState> {
    try {
      return await loadRun(paths.runsDir, runId);
    } catch (cause) {
      if (cause instanceof RunNotFoundError) {
        throw new CoreRunNotFoundError(runId, operation, cause);
      }

      throw cause;
    }
  }

  private async toRunView(
    paths: AiraProjectPaths,
    state: RunState,
    workflow: Workflow | undefined,
    workflowIssue?: string,
  ): Promise<RunView> {
    const artifacts = toArtifactMetadata(state, workflow);
    const steps = toRunSteps(state, workflow);
    const knownCurrentStep = steps.find(
      (step) => step.id === state.current_step,
    );
    const fallbackCurrentStep = toBoundaryStep(state, workflow);
    const currentStep =
      knownCurrentStep ??
      (fallbackCurrentStep === undefined
        ? undefined
        : { ...fallbackCurrentStep });
    const pending = toPendingRevision(state);
    let boundary: RunBoundary | undefined;

    if (state.status !== "running") {
      boundary = await this.toBoundary(paths, state, workflow, {
        artifactReadMode: "best-effort",
      });
    }

    let resumable = false;
    let resumeReason: string | undefined;

    if (boundary?.kind === "interrupted") {
      resumable = boundary.resumable;
      resumeReason = boundary.resumeReason;
    } else if (pending !== undefined) {
      if (workflow === undefined) {
        resumeReason =
          `workflow "${state.workflow}" is unavailable, so resume cannot ` +
          "be validated";
      } else {
        try {
          prepareRunForResume(workflow, state);
          resumable = true;
        } catch (cause) {
          resumeReason = getErrorMessage(cause);
        }
      }
    }

    const allowedActions =
      boundary?.allowedActions ?? (resumable ? (["resume"] as RunAction[]) : []);

    return {
      runId: state.id,
      workflow: state.workflow,
      checkpointToken:
        boundary?.checkpointToken ??
        getRunCheckpointToken(state, { workflow }),
      status: state.status,
      ...(typeof state.input.task === "string" ? { task: state.input.task } : {}),
      startedAt: state.started_at,
      updatedAt: state.updated_at,
      summary:
        boundary?.summary ?? summarizeRunningState(state, pending, resumable),
      ...(currentStep === undefined ? {} : { currentStep }),
      steps,
      artifacts,
      allowedActions,
      resumable,
      workflowAvailable: workflow !== undefined,
      ...(workflowIssue === undefined ? {} : { workflowIssue }),
      ...(resumeReason === undefined ? {} : { resumeReason }),
      ...(pending === undefined ? {} : { pendingRevision: pending }),
      ...(boundary === undefined ? {} : { boundary }),
    };
  }

  private async toBoundary(
    paths: AiraProjectPaths,
    state: RunState,
    workflow: Workflow | undefined,
    options: { artifactReadMode?: "strict" | "best-effort" } = {},
  ): Promise<RunBoundary> {
    const artifacts = toArtifactMetadata(state, workflow);
    const currentStep = toBoundaryStep(state, workflow);
    const base = {
      runId: state.id,
      workflow: state.workflow,
      checkpointToken: getRunCheckpointToken(state, { workflow }),
      currentStep,
      artifacts,
    };

    switch (state.status) {
      case "completed":
        return {
          ...base,
          kind: "completed",
          status: "completed",
          summary: summarizeCompletedState(state, artifacts.length),
          allowedActions: [],
        };
      case "failed": {
        const failure = summarizeFailure(state);
        return {
          ...base,
          kind: "failed",
          status: "failed",
          summary: failure.message,
          allowedActions: [],
          failure,
        };
      }
      case "cancelled":
        return {
          ...base,
          kind: "cancelled",
          status: "cancelled",
          summary: `Run "${state.id}" was cancelled.`,
          allowedActions: [],
        };
      case "interrupted": {
        let resumable = false;
        let resumeReason: string | undefined;

        if (workflow === undefined) {
          resumeReason =
            `workflow "${state.workflow}" is unavailable, so resume cannot ` +
            "be validated";
        } else {
          try {
            prepareRunForResume(workflow, state);
            resumable = true;
          } catch (cause) {
            resumeReason = getErrorMessage(cause);
          }
        }

        return {
          ...base,
          kind: "interrupted",
          status: "interrupted",
          summary: resumable
            ? `Run interrupted at "${state.current_step ?? "unknown"}" and can be resumed.`
            : `Run interrupted at "${state.current_step ?? "unknown"}" and cannot be resumed safely.`,
          allowedActions: resumable ? ["resume"] : [],
          resumable,
          ...(resumeReason === undefined ? {} : { resumeReason }),
        };
      }
      case "waiting":
        return await this.toWaitingBoundary(
          paths,
          state,
          workflow,
          artifacts,
          currentStep,
          options.artifactReadMode ?? "strict",
        );
      case "running":
        throw new IncompatibleRunStateError({
          operation: "classifyBoundary",
          runId: state.id,
          workflow: state.workflow,
          stepId: state.current_step,
          message:
            `run "${state.id}" is still running and has not reached a ` +
            "lifecycle boundary",
        });
    }
  }

  private async toWaitingBoundary(
    paths: AiraProjectPaths,
    state: RunState,
    workflow: Workflow | undefined,
    artifacts: ArtifactMetadata[],
    currentStep: BoundaryStep | undefined,
    artifactReadMode: "strict" | "best-effort",
  ): Promise<RunBoundary> {
    if (workflow === undefined) {
      return manualBoundary({
        state,
        artifacts,
        currentStep,
        reason: "workflow-unavailable",
        message:
          `workflow "${state.workflow}" is unavailable; waiting state ` +
          "cannot be classified safely",
        checkpointToken: getRunCheckpointToken(state),
      });
    }

    const step =
      state.current_step === undefined
        ? undefined
        : findWorkflowStep(workflow, state.current_step);

    if (step?.uses === "loop") {
      const attempts = state.steps[step.id]?.attempt;
      return manualBoundary({
        state,
        artifacts,
        currentStep,
        reason: "loop-exhausted",
        message:
          `loop "${step.id}" exhausted its ${step.max_attempts} attempts; ` +
          "manual loop intervention is not supported",
        maxAttempts: step.max_attempts,
        attempts,
        checkpointToken: getRunCheckpointToken(state, { workflow }),
      });
    }

    if (step?.uses !== "approval") {
      return manualBoundary({
        state,
        artifacts,
        currentStep,
        reason: "unsupported-waiting-state",
        message:
          `run "${state.id}" is waiting at unsupported step ` +
          `"${state.current_step ?? "missing"}"`,
        checkpointToken: getRunCheckpointToken(state, { workflow }),
      });
    }

    const decisions: Array<"approve" | "revise" | "cancel"> = ["approve"];

    if (step.revise !== undefined) {
      decisions.push("revise");
    }

    decisions.push("cancel");
    let artifactView:
      | import("./types").ApprovalArtifactView
      | undefined;

    if (step.artifact !== undefined) {
      const metadata = artifacts.find((item) => item.name === step.artifact);

      if (metadata === undefined) {
        artifactView = { name: step.artifact, available: false };
      } else {
        try {
          const content = await this.artifactReader({
            runsRoot: paths.runsDir,
            state,
            name: step.artifact,
          });
          artifactView = {
            ...metadata,
            available: true,
            content,
          };
        } catch (cause) {
          if (artifactReadMode === "strict") {
            throw cause;
          }

          artifactView = {
            name: step.artifact,
            available: false,
            reason: getErrorMessage(cause),
          };
        }
      }
    }

    const checkpointArtifact =
      artifactView?.available === true
        ? {
            name: artifactView.name,
            path: artifactView.currentPath,
            content: artifactView.content,
          }
        : undefined;
    const approvalMessage = step.message ?? `Approve step "${step.id}"?`;

    return {
      runId: state.id,
      workflow: state.workflow,
      checkpointToken: getRunCheckpointToken(state, {
        workflow,
        approval: {
          stepId: step.id,
          message: approvalMessage,
          revisionTargetStepId: step.revise,
          artifact: checkpointArtifact,
        },
      }),
      kind: "approval-required",
      status: "waiting",
      summary: `Waiting for approval at "${step.id}".`,
      currentStep,
      allowedActions: [...decisions],
      artifacts,
      approval: {
        stepId: step.id,
        message: approvalMessage,
        ...(artifactView === undefined ? {} : { artifact: artifactView }),
        ...(step.revise === undefined
          ? {}
          : { revisionTargetStepId: step.revise }),
        allowedDecisions: decisions,
      },
    };
  }

  private readClock(operation: string): Date {
    let value: Date;

    try {
      value = this.clock();
    } catch (cause) {
      throw new InvalidRunInputError(
        `${operation} clock failed: ${getErrorMessage(cause)}`,
        operation,
      );
    }

    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new InvalidRunInputError(
        `${operation} clock must return a valid Date`,
        operation,
      );
    }

    return value;
  }
}

export function createAiraCore(
  cwd: string,
  dependencies: AiraCoreDependencies = {},
): AiraCore {
  return new AiraCore({ cwd, ...dependencies });
}

interface RunCheckpointContext {
  workflow?: Workflow;
  approval?: {
    stepId: string;
    message: string;
    revisionTargetStepId?: string;
    artifact?: { name: string; path: string; content: string };
  };
}

function getRunCheckpointToken(
  state: RunState,
  context: RunCheckpointContext = {},
): string {
  const hash = createHash("sha256").update(stableJson(state));

  if (context.workflow !== undefined) {
    hash.update("\0workflow\0");
    hash.update(stableJson(context.workflow));
  }

  if (context.approval !== undefined) {
    const { artifact, ...approval } = context.approval;
    hash.update("\0approval\0");
    hash.update(stableJson(approval));

    if (artifact !== undefined) {
      hash.update("\0approval-artifact\0");
      hash.update(artifact.name);
      hash.update("\0");
      hash.update(artifact.path);
      hash.update("\0");
      hash.update(artifact.content);
    }
  }

  return hash.digest("hex");
}

function getPreparationToken(prepared: PreparedWorkflow): string {
  const agentSteps = [...prepared.preflight.agentSteps.entries()].map(
    ([stepId, value]) => ({
      stepId,
      command: {
        name: value.command.name,
        metadata: value.command.metadata,
        prompt: value.command.prompt,
      },
      configuration: value.configuration,
    }),
  );
  return createHash("sha256")
    .update(
      stableJson({
        config: prepared.config,
        workflow: prepared.workflow,
        agentSteps,
      }),
    )
    .digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .flatMap((key) =>
        record[key] === undefined
          ? []
          : [[key, sortJsonValue(record[key])]],
      ),
  );
}

function validateTask(
  task: string,
  operation: string,
  workflow: string,
): void {
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new InvalidRunInputError(
      "run task must not be empty",
      operation,
      workflow,
    );
  }
}

function toWorkflowInfo(workflow: Workflow): WorkflowInfo {
  const steps = flattenWorkflowSteps(workflow);
  return {
    name: workflow.name,
    ...(workflow.description === undefined
      ? {}
      : { description: workflow.description }),
    stepCount: steps.length,
    topLevelStepCount: workflow.steps.length,
    hasAgentSteps: steps.some((step) => step.uses === "agent"),
  };
}

function toPreviewStep(
  step: WorkflowStep,
  preflight: WorkflowPreflightResult,
  parentStepId?: string,
): RunPreviewStep {
  const base = {
    id: step.id,
    type: step.uses,
    ...(parentStepId === undefined ? {} : { parentStepId }),
  };

  switch (step.uses) {
    case "agent": {
      const prepared = preflight.agentSteps.get(step.id);
      const configuration = prepared?.configuration;
      return {
        ...base,
        command: step.command,
        ...(step.artifact === undefined
          ? {}
          : {
              artifact: {
                name: step.artifact.name,
                filename: step.artifact.filename,
                versioned: step.artifact.versioned ?? false,
              },
            }),
        ...(configuration === undefined
          ? {}
          : { agent: copyAgentConfiguration(configuration) }),
      };
    }
    case "shell":
      return base;
    case "approval":
      return {
        ...base,
        ...(step.artifact === undefined
          ? {}
          : { approvalArtifact: step.artifact }),
        ...(step.message === undefined
          ? {}
          : { approvalMessage: step.message }),
        ...(step.revise === undefined
          ? {}
          : { revisionTargetStepId: step.revise }),
      };
    case "loop":
      return {
        ...base,
        maxAttempts: step.max_attempts,
        steps: step.steps.map((child) =>
          toPreviewStep(child, preflight, step.id),
        ),
      };
  }
}

function copyAgentConfiguration(
  configuration: PreviewAgentConfiguration,
): PreviewAgentConfiguration {
  return {
    ...(configuration.model === undefined
      ? {}
      : { model: configuration.model }),
    ...(configuration.thinking === undefined
      ? {}
      : { thinking: configuration.thinking }),
    timeoutSeconds: configuration.timeoutSeconds,
    technicalRetries: configuration.technicalRetries,
    tools: [...configuration.tools],
  };
}

async function loadWorkflowForInspection(
  paths: AiraProjectPaths,
  name: string,
): Promise<{ workflow?: Workflow; issue?: string }> {
  try {
    return { workflow: (await loadNamedWorkflow(paths.workflowsDir, name)).workflow };
  } catch (cause) {
    return { issue: getErrorMessage(cause) };
  }
}

function toRunSteps(
  state: RunState,
  workflow: Workflow | undefined,
): RunStepView[] {
  const locations = workflowStepLocations(workflow);
  return Object.entries(state.steps).map(([id, step]) => {
    const location = locations.get(id);
    return {
      id,
      type: location?.step.uses ?? "unknown",
      status: step.status,
      attempt: step.attempt,
      ...(location?.parentStepId === undefined
        ? {}
        : { parentStepId: location.parentStepId }),
      ...(step.started_at === undefined ? {} : { startedAt: step.started_at }),
      ...(step.completed_at === undefined
        ? {}
        : { completedAt: step.completed_at }),
      ...(step.success === undefined ? {} : { success: step.success }),
      ...(step.summary === undefined ? {} : { summary: step.summary }),
      ...(step.artifact === undefined
        ? {}
        : { artifactPath: step.artifact }),
    };
  });
}

function toBoundaryStep(
  state: RunState,
  workflow: Workflow | undefined,
): BoundaryStep | undefined {
  const id = state.current_step;

  if (id === undefined) {
    return undefined;
  }

  const stepState = state.steps[id];

  if (stepState === undefined) {
    return {
      id,
      type: workflowStepLocations(workflow).get(id)?.step.uses ?? "unknown",
      status: "pending",
      attempt: 0,
    };
  }

  return {
    id,
    type: workflowStepLocations(workflow).get(id)?.step.uses ?? "unknown",
    status: stepState.status,
    attempt: stepState.attempt,
  };
}

function workflowStepLocations(
  workflow: Workflow | undefined,
): Map<string, { step: WorkflowStep; parentStepId?: string }> {
  const result = new Map<
    string,
    { step: WorkflowStep; parentStepId?: string }
  >();

  if (workflow === undefined) {
    return result;
  }

  const visit = (steps: readonly WorkflowStep[], parentStepId?: string) => {
    for (const step of steps) {
      result.set(step.id, {
        step,
        ...(parentStepId === undefined ? {} : { parentStepId }),
      });

      if (step.uses === "loop") {
        visit(step.steps, step.id);
      }
    }
  };

  visit(workflow.steps);
  return result;
}

function toArtifactMetadata(
  state: RunState,
  workflow: Workflow | undefined,
): ArtifactMetadata[] {
  const producers = new Map<string, string>();

  if (workflow !== undefined) {
    for (const step of flattenWorkflowSteps(workflow)) {
      if (step.uses === "agent" && step.artifact !== undefined) {
        producers.set(step.artifact.name, step.id);
      }
    }
  }

  return Object.entries(state.artifacts)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, artifact]) => ({
      name,
      currentPath: artifact.current,
      versioned: artifact.versions !== undefined,
      versionCount: artifact.versions?.length ?? 1,
      versions: toArtifactVersions(artifact),
      ...(producers.get(name) === undefined
        ? {}
        : { producerStepId: producers.get(name) }),
    }));
}

function toArtifactVersions(
  artifact: ArtifactState,
): ArtifactVersionMetadata[] {
  const paths = artifact.versions ?? [artifact.current];
  return paths.map((storedPath, index) => ({
    path: storedPath,
    isCurrent: storedPath === artifact.current,
    ...(artifact.versions === undefined ? {} : { version: index + 1 }),
  }));
}

function getOwnArtifact(
  state: RunState,
  name: string,
): ArtifactState | undefined {
  return Object.prototype.hasOwnProperty.call(state.artifacts, name)
    ? state.artifacts[name]
    : undefined;
}

function toPendingRevision(state: RunState): PendingRevisionView | undefined {
  const pending = getPendingRevision(state);

  if (pending === undefined) {
    return undefined;
  }

  return {
    approvalStepId: pending.approval_step,
    targetStepId: pending.target_step,
    feedback: pending.feedback,
    requestedAt: pending.requested_at,
    ...(pending.previous_artifact === undefined
      ? {}
      : {
          previousArtifact: {
            name: pending.previous_artifact.name,
            path: pending.previous_artifact.path,
          },
        }),
  };
}

function summarizeCompletedState(
  state: RunState,
  artifactCount: number,
): string {
  const summary = [...Object.values(state.steps)]
    .reverse()
    .find((step) => step.status === "completed" && step.summary !== undefined)
    ?.summary;

  if (summary !== undefined && summary.trim().length > 0) {
    return sanitizeDisplayText(summary, 500);
  }

  return (
    `Workflow "${state.workflow}" completed with ${artifactCount} ` +
    `artifact${artifactCount === 1 ? "" : "s"}.`
  );
}

function summarizeFailure(state: RunState): {
  stepId?: string;
  message: string;
} {
  const current =
    state.current_step === undefined ? undefined : state.steps[state.current_step];
  const message = current?.output ?? current?.summary;
  const fallback =
    state.current_step === undefined
      ? `Run "${state.id}" failed.`
      : `Run failed at step "${state.current_step}".`;
  return {
    ...(state.current_step === undefined ? {} : { stepId: state.current_step }),
    message:
      message === undefined || message.trim().length === 0
        ? fallback
        : sanitizeDisplayText(message, 500),
  };
}

function summarizeRunningState(
  state: RunState,
  pending: PendingRevisionView | undefined,
  resumable: boolean,
): string {
  if (pending !== undefined) {
    return resumable
      ? `Revision for "${pending.targetStepId}" is pending and can be resumed.`
      : `Revision for "${pending.targetStepId}" is pending but cannot be resumed safely.`;
  }

  return state.current_step === undefined
    ? `Run "${state.id}" is marked running.`
    : `Run "${state.id}" is marked running at "${state.current_step}".`;
}

function manualBoundary(params: {
  state: RunState;
  artifacts: ArtifactMetadata[];
  currentStep?: BoundaryStep;
  reason: "loop-exhausted" | "workflow-unavailable" | "unsupported-waiting-state";
  message: string;
  maxAttempts?: number;
  attempts?: number;
  checkpointToken: string;
}): RunBoundary {
  return {
    runId: params.state.id,
    workflow: params.state.workflow,
    checkpointToken: params.checkpointToken,
    kind: "manual-intervention",
    status: "waiting",
    summary: params.message,
    ...(params.currentStep === undefined
      ? {}
      : { currentStep: params.currentStep }),
    allowedActions: [],
    artifacts: params.artifacts,
    reason: params.reason,
    intervention: {
      supported: false,
      message: params.message,
      ...(params.maxAttempts === undefined
        ? {}
        : { maxAttempts: params.maxAttempts }),
      ...(params.attempts === undefined ? {} : { attempts: params.attempts }),
    },
  };
}

function invalidDecisionForBoundary(
  action: "approve" | "revise" | "cancel",
  boundary: RunBoundary,
): InvalidLifecycleActionError {
  return new InvalidLifecycleActionError({
    runId: boundary.runId,
    action,
    stepId: boundary.currentStep?.id,
    allowedActions: boundary.allowedActions,
    message:
      `run "${boundary.runId}" is at boundary "${boundary.kind}" and ` +
      `cannot accept action "${action}"`,
  });
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.split(/\r\n|\n|\r/).length;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
