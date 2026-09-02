import { PiRuntime, type AgentRuntime } from "../agent";
import type { readArtifact } from "../artifacts";
import { loadConfig, type AiraConfig } from "../config";
import {
  executeWorkflow,
  preflightWorkflow,
  type WorkflowPreflightResult,
} from "../executor";
import {
  inspectGitWorkingTree,
  type GitCommandRunner,
} from "../git";
import {
  discoverAiraProject,
  initializeAiraProject,
  type AiraProjectPaths,
} from "../project";
import {
  createRun,
  findLatestRunId,
  isPendingRevisionResumeState,
  loadRun,
  type RunState,
} from "../run";
import {
  findWorkflowStep,
  flattenWorkflowStepIds,
  loadNamedWorkflow,
  loadWorkflowCatalog,
  type Workflow,
} from "../workflow";
import type { ApprovalDecisionApplier } from "./approval";
import type { ParsedCliCommand } from "./args";
import { printDryRunPlan } from "./dry-run";
import { CLI_EXIT_SUCCESS, type CliExitCode } from "./exit-codes";
import type { CliIO } from "./io";
import { runLifecycle, type WorkflowExecutor } from "./lifecycle";
import type { SigintSource } from "./signals";
import { formatRunStatus } from "./status";

export interface CliCommandDependencies {
  io: CliIO;
  cwd: string;
  agentRuntimeFactory?: () => AgentRuntime;
  executor?: WorkflowExecutor;
  approvalDecisionApplier?: ApprovalDecisionApplier;
  approvalArtifactReader?: typeof readArtifact;
  gitCommandRunner?: GitCommandRunner;
  sigintSource?: SigintSource;
}

interface PreparedWorkflow {
  paths: AiraProjectPaths;
  config: AiraConfig;
  workflow: Workflow;
  preflight: WorkflowPreflightResult;
}

export async function executeCliCommand(
  command: Exclude<ParsedCliCommand, { command: "help" }>,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  switch (command.command) {
    case "init":
      return executeInit(dependencies);
    case "list":
      return executeList(dependencies);
    case "run":
      return executeRun(command, dependencies);
    case "status":
      return executeStatus(command.runId, dependencies);
    case "resume":
      return executeResume(command.runId, dependencies);
  }
}

async function executeInit(
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const result = await initializeAiraProject(dependencies.cwd);

  dependencies.io.writeOut(
    result.created
      ? `Initialized Aira in ${result.paths.root}\n`
      : `Aira is already initialized in ${result.paths.root}\n`,
  );
  return CLI_EXIT_SUCCESS;
}

async function executeList(
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const paths = await discoverAiraProject(dependencies.cwd);
  const entries = await loadWorkflowCatalog(paths.workflowsDir);

  if (entries.length === 0) {
    dependencies.io.writeOut("No workflows found.\n");
    return CLI_EXIT_SUCCESS;
  }

  const width = Math.max(...entries.map((entry) => entry.workflow.name.length));

  for (const { workflow } of entries) {
    dependencies.io.writeOut(
      workflow.description === undefined
        ? `${workflow.name}\n`
        : `${workflow.name.padEnd(width)}  ${workflow.description}\n`,
    );
  }

  return CLI_EXIT_SUCCESS;
}

async function executeRun(
  command: Extract<ParsedCliCommand, { command: "run" }>,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const prepared = await prepareWorkflow(
    dependencies.cwd,
    command.workflow,
  );

  if (command.dryRun) {
    printDryRunPlan({
      workflow: prepared.workflow,
      task: command.task,
      preflight: prepared.preflight,
      io: dependencies.io,
    });
    return CLI_EXIT_SUCCESS;
  }

  if (!command.allowDirty) {
    const git = await inspectGitWorkingTree(
      prepared.paths.root,
      dependencies.gitCommandRunner,
    );

    if (git.dirty) {
      throw new Error(
        "working tree is dirty; commit/stash changes or use --allow-dirty",
      );
    }
  }

  const agentRuntime = createAgentRuntime(prepared, dependencies);
  const state = await createRun({
    runsRoot: prepared.paths.runsDir,
    workflow: prepared.workflow.name,
    input: { task: command.task },
    stepIds: flattenWorkflowStepIds(prepared.workflow),
  });

  return await runLifecycle({
    workflow: prepared.workflow,
    config: prepared.config,
    paths: prepared.paths,
    state,
    cwd: prepared.paths.root,
    io: dependencies.io,
    sigintSource: dependencies.sigintSource,
    initialMode: "fresh",
    executeFirst: true,
    agentRuntime,
    executor: dependencies.executor ?? executeWorkflow,
    approvalDecisionApplier: dependencies.approvalDecisionApplier,
    approvalArtifactReader: dependencies.approvalArtifactReader,
  });
}

async function executeStatus(
  requestedRunId: string | undefined,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const paths = await discoverAiraProject(dependencies.cwd);
  const runId = requestedRunId ?? (await findLatestRunId(paths.runsDir));

  if (runId === undefined) {
    dependencies.io.writeOut("No Aira runs found.\n");
    return CLI_EXIT_SUCCESS;
  }

  const state = await loadRun(paths.runsDir, runId);
  dependencies.io.writeOut(formatRunStatus(state));
  return CLI_EXIT_SUCCESS;
}

async function executeResume(
  runId: string,
  dependencies: CliCommandDependencies,
): Promise<CliExitCode> {
  const paths = await discoverAiraProject(dependencies.cwd);
  const state = await loadRun(paths.runsDir, runId);

  if (
    state.status !== "interrupted" &&
    state.status !== "waiting" &&
    !isPendingRevisionResumeState(state)
  ) {
    throw resumeStatusError(state);
  }

  const prepared = await prepareWorkflow(paths.root, state.workflow);

  if (prepared.workflow.name !== state.workflow) {
    throw new Error(
      `run "${state.id}" workflow "${state.workflow}" does not match ` +
        `loaded workflow "${prepared.workflow.name}"`,
    );
  }

  if (state.status === "waiting") {
    const stepId = state.current_step;
    const step =
      stepId === undefined
        ? undefined
        : findWorkflowStep(prepared.workflow, stepId);

    if (stepId === undefined || step === undefined) {
      throw new Error(
        `waiting run "${state.id}" has an invalid current step ` +
          `"${stepId ?? "missing"}"`,
      );
    }

    if (step.uses === "loop") {
      return await runLifecycle({
        workflow: prepared.workflow,
        config: prepared.config,
        paths: prepared.paths,
        state,
        cwd: prepared.paths.root,
        io: dependencies.io,
        sigintSource: dependencies.sigintSource,
        initialMode: "resume",
        executeFirst: false,
        executor: dependencies.executor ?? executeWorkflow,
      });
    }

    if (step.uses !== "approval") {
      throw new Error(
        `run "${state.id}" is waiting at unsupported step "${step.id}"`,
      );
    }
  }

  const agentRuntime = createAgentRuntime(prepared, dependencies);

  return await runLifecycle({
    workflow: prepared.workflow,
    config: prepared.config,
    paths: prepared.paths,
    state,
    cwd: prepared.paths.root,
    io: dependencies.io,
    sigintSource: dependencies.sigintSource,
    initialMode: "resume",
    executeFirst:
      state.status === "interrupted" || isPendingRevisionResumeState(state),
    agentRuntime,
    executor: dependencies.executor ?? executeWorkflow,
    approvalDecisionApplier: dependencies.approvalDecisionApplier,
    approvalArtifactReader: dependencies.approvalArtifactReader,
  });
}

async function prepareWorkflow(
  cwd: string,
  workflowName: string,
): Promise<PreparedWorkflow> {
  const paths = await discoverAiraProject(cwd);
  const config = await loadConfig(paths.configFile);
  const { workflow } = await loadNamedWorkflow(
    paths.workflowsDir,
    workflowName,
  );
  const preflight = await preflightWorkflow({
    workflow,
    config,
    commandsDir: paths.commandsDir,
  });

  return { paths, config, workflow, preflight };
}

function createAgentRuntime(
  prepared: PreparedWorkflow,
  dependencies: CliCommandDependencies,
): AgentRuntime | undefined {
  if (prepared.preflight.agentSteps.size === 0) {
    return undefined;
  }

  return (dependencies.agentRuntimeFactory ?? (() => new PiRuntime()))();
}

function resumeStatusError(state: RunState): Error {
  if (state.status === "running") {
    return new Error(
      `run "${state.id}" is "running"; automatic crash recovery is not implemented`,
    );
  }

  return new Error(
    `run "${state.id}" is "${state.status}" and cannot be resumed`,
  );
}
