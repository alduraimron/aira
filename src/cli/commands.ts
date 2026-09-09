import { PiRuntime, type AgentRuntime } from "../agent";
import type { readArtifact } from "../artifacts";
import {
  AiraCore,
  CoreRunNotFoundError,
  type CoreWorkflowExecutor,
  type RunBoundary,
} from "../core";
import type { GitCommandRunner } from "../git";
import type { ApprovalDecisionApplier } from "./approval";
import type { ParsedCliCommand } from "./args";
import { printDryRunPlan } from "./dry-run";
import { CLI_EXIT_SUCCESS, type CliExitCode } from "./exit-codes";
import type { CliIO } from "./io";
import { runLifecycle } from "./lifecycle";
import {
  createCliExecutionReporter,
  type ExecutionReporter,
} from "./reporter";
import type { SigintSource } from "./signals";
import { processSigintSource, withSigintAbort } from "./signals";
import { formatRunStatus } from "./status";

export type WorkflowExecutor = CoreWorkflowExecutor;

export interface CliCommandDependencies {
  io: CliIO;
  cwd: string;
  core?: AiraCore;
  agentRuntimeFactory?: () => AgentRuntime;
  executor?: WorkflowExecutor;
  approvalDecisionApplier?: ApprovalDecisionApplier;
  approvalArtifactReader?: typeof readArtifact;
  gitCommandRunner?: GitCommandRunner;
  sigintSource?: SigintSource;
}

export async function executeCliCommand(
  command: Exclude<ParsedCliCommand, { command: "help" }>,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const core =
    dependencies.core ??
    new AiraCore({
      cwd: dependencies.cwd,
      agentRuntimeFactory:
        dependencies.agentRuntimeFactory ?? (() => new PiRuntime()),
      executor: dependencies.executor,
      approvalDecisionApplier: dependencies.approvalDecisionApplier,
      artifactReader: dependencies.approvalArtifactReader,
      gitCommandRunner: dependencies.gitCommandRunner,
    });

  switch (command.command) {
    case "init":
      return executeInit(core, dependencies.io);
    case "list":
      return executeList(core, dependencies.io);
    case "run":
      return executeRun(command, core, dependencies);
    case "status":
      return executeStatus(command.runId, core, dependencies.io);
    case "resume":
      return executeResume(command.runId, core, dependencies);
  }
}

async function executeInit(core: AiraCore, io: CliIO): Promise<CliExitCode> {
  const project = await core.initializeProject();

  if (!project.initialized) {
    throw new Error("Aira initialization did not produce a project");
  }

  io.writeOut(
    project.created === true
      ? `Initialized Aira in ${project.root}\n`
      : `Aira is already initialized in ${project.root}\n`,
  );
  return CLI_EXIT_SUCCESS;
}

async function executeList(core: AiraCore, io: CliIO): Promise<CliExitCode> {
  const workflows = await core.listWorkflows();

  if (workflows.length === 0) {
    io.writeOut("No workflows found.\n");
    return CLI_EXIT_SUCCESS;
  }

  const width = Math.max(...workflows.map((workflow) => workflow.name.length));

  for (const workflow of workflows) {
    io.writeOut(
      workflow.description === undefined
        ? `${workflow.name}\n`
        : `${workflow.name.padEnd(width)}  ${workflow.description}\n`,
    );
  }

  return CLI_EXIT_SUCCESS;
}

async function executeRun(
  command: Extract<ParsedCliCommand, { command: "run" }>,
  core: AiraCore,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  if (command.dryRun) {
    const preview = await core.previewRun({
      workflow: command.workflow,
      task: command.task,
    });
    printDryRunPlan(preview, dependencies.io);
    return CLI_EXIT_SUCCESS;
  }

  const reporter = createCliExecutionReporter(dependencies.io);
  const boundary = await executeWithSignal(
    dependencies,
    (signal) =>
      core.startRun(
        {
          workflow: command.workflow,
          task: command.task,
          allowDirty: command.allowDirty,
        },
        { signal, onEvent: reporter.emit },
      ),
  );
  return await runBoundaryLifecycle(core, boundary, dependencies, reporter);
}

async function executeStatus(
  runId: string | undefined,
  core: AiraCore,
  io: CliIO,
): Promise<CliExitCode> {
  const view = await core.inspectRun(runId);

  if (view === undefined) {
    io.writeOut("No Aira runs found.\n");
    return CLI_EXIT_SUCCESS;
  }

  io.writeOut(formatRunStatus(view));
  return CLI_EXIT_SUCCESS;
}

async function executeResume(
  runId: string,
  core: AiraCore,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const view = await core.inspectRun(runId);

  if (view === undefined) {
    throw new CoreRunNotFoundError(runId, "inspectRun");
  }

  if (
    view.boundary?.kind === "approval-required" ||
    view.boundary?.kind === "manual-intervention"
  ) {
    return await runBoundaryLifecycle(
      core,
      view.boundary,
      dependencies,
      createCliExecutionReporter(dependencies.io),
    );
  }

  const reporter = createCliExecutionReporter(dependencies.io);
  const boundary = await executeWithSignal(
    dependencies,
    (signal) =>
      core.continueRun(
        {
          runId,
          action: "resume",
          expectedBoundaryToken: view.checkpointToken,
        },
        { signal, onEvent: reporter.emit },
      ),
  );
  return await runBoundaryLifecycle(core, boundary, dependencies, reporter);
}

async function runBoundaryLifecycle(
  core: AiraCore,
  boundary: RunBoundary,
  dependencies: CliCommandDependencies,
  reporter: ExecutionReporter,
): Promise<CliExitCode> {
  return await runLifecycle({
    core,
    boundary,
    io: dependencies.io,
    sigintSource: dependencies.sigintSource,
    reporter,
  });
}

async function executeWithSignal(
  dependencies: CliCommandDependencies,
  execute: (signal: AbortSignal) => Promise<RunBoundary>,
): Promise<RunBoundary> {
  return await withSigintAbort({
    io: dependencies.io,
    source: dependencies.sigintSource ?? processSigintSource,
    execute,
  });
}
