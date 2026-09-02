import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadCommand, type AgentCommand } from "../../src/commands";
import { loadConfig } from "../../src/config";
import { preflightWorkflow } from "../../src/executor";
import { initializeAiraProject, type AiraProjectPaths } from "../../src/project";
import { interpolateTemplate } from "../../src/template";
import {
  flattenWorkflowSteps,
  loadWorkflowCatalog,
  type Workflow,
} from "../../src/workflow";

const EXPECTED_COMMAND_FILES = [
  "discover.md",
  "implement.md",
  "investigate.md",
  "plan.md",
  "repair.md",
  "review.md",
  "summary.md",
] as const;
const EXPECTED_WORKFLOW_FILES = [
  "bugfix.yaml",
  "feature.yaml",
  "investigate.yaml",
] as const;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const MUTATION_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
];

let directory: string;
let paths: AiraProjectPaths;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-defaults-"));
  paths = (await initializeAiraProject(directory)).paths;
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function loadDefaultCommands(): Promise<Map<string, AgentCommand>> {
  const commands = await Promise.all(
    EXPECTED_COMMAND_FILES.map((filename) =>
      loadCommand(path.join(paths.commandsDir, filename)),
    ),
  );
  return new Map(commands.map((command) => [command.name, command]));
}

function requireCommand(
  commands: ReadonlyMap<string, AgentCommand>,
  name: string,
): AgentCommand {
  const command = commands.get(name);

  if (command === undefined) {
    throw new Error(`missing default command "${name}"`);
  }

  return command;
}

function requireWorkflow(
  workflows: readonly Workflow[],
  name: string,
): Workflow {
  const workflow = workflows.find((candidate) => candidate.name === name);

  if (workflow === undefined) {
    throw new Error(`missing default workflow "${name}"`);
  }

  return workflow;
}

describe("V1 default project files", () => {
  test("loads every config, workflow, and command through public loaders", async () => {
    expect((await readdir(paths.workflowsDir)).sort()).toEqual([
      ...EXPECTED_WORKFLOW_FILES,
    ]);
    expect((await readdir(paths.commandsDir)).sort()).toEqual([
      ...EXPECTED_COMMAND_FILES,
    ]);

    const config = await loadConfig(paths.configFile);
    const catalog = await loadWorkflowCatalog(paths.workflowsDir);
    const commands = await loadDefaultCommands();

    expect(config).toEqual({
      models: {},
      defaults: {
        agent_timeout: 900,
        shell_timeout: 300,
        technical_retries: 1,
      },
      commands: {},
    });
    expect(catalog.map(({ workflow }) => workflow.name)).toEqual([
      "bugfix",
      "feature",
      "investigate",
    ]);
    expect([...commands.keys()].sort()).toEqual([
      "discover",
      "implement",
      "investigate",
      "plan",
      "repair",
      "review",
      "summary",
    ]);

    for (const { workflow } of catalog) {
      const preflight = await preflightWorkflow({
        workflow,
        config,
        commandsDir: paths.commandsDir,
      });

      for (const step of flattenWorkflowSteps(workflow)) {
        if (step.uses !== "agent") {
          continue;
        }

        expect(commands.has(step.command)).toBe(true);
        expect(preflight.agentSteps.has(step.id)).toBe(true);
        expect(step.model).toBeUndefined();
        expect(commands.get(step.command)?.metadata.model).toBeUndefined();
      }
    }
  });

  test("keeps approval references valid and plans versioned", async () => {
    const workflows = (await loadWorkflowCatalog(paths.workflowsDir)).map(
      ({ workflow }) => workflow,
    );

    for (const workflowName of ["feature", "bugfix"]) {
      const workflow = requireWorkflow(workflows, workflowName);
      const plan = workflow.steps.find((step) => step.id === "plan");
      const approval = workflow.steps.find(
        (step) => step.id === "approve-plan",
      );

      expect(plan).toMatchObject({
        uses: "agent",
        artifact: {
          name: "plan",
          filename: "plan.md",
          versioned: true,
        },
      });
      expect(approval).toEqual({
        id: "approve-plan",
        uses: "approval",
        artifact: "plan",
        message: "Approve this implementation plan?",
        revise: "plan",
      });
    }
  });

  test("resolves every shipped command template at its default use site", async () => {
    const config = await loadConfig(paths.configFile);
    const workflows = (await loadWorkflowCatalog(paths.workflowsDir)).map(
      ({ workflow }) => workflow,
    );
    const commands = await loadDefaultCommands();

    for (const workflow of workflows) {
      const artifacts: Record<string, unknown> = {};
      const steps = Object.fromEntries(
        flattenWorkflowSteps(workflow).map((step) => [
          step.id,
          { status: "pending", attempt: 0 },
        ]),
      );

      for (const step of flattenWorkflowSteps(workflow)) {
        if (step.uses !== "agent") {
          continue;
        }

        const command = requireCommand(commands, step.command);
        expect(() =>
          interpolateTemplate(command.prompt, {
            input: { task: "Implement JWT authentication" },
            config: { ...config },
            artifacts,
            revision: {
              active: false,
              feedback: "",
              previous_artifact: "",
            },
            steps,
            run: {
              id: "20260827-120000-a1b2c3d4",
              workflow: workflow.name,
              status: "running",
            },
          }),
        ).not.toThrow();

        if (step.artifact !== undefined) {
          artifacts[step.artifact.name] = `${step.artifact.name} content`;
        }
      }
    }

    const repair = requireCommand(commands, "repair");
    expect(() =>
      interpolateTemplate(repair.prompt, {
        input: { task: "Fix authentication" },
        config: { ...config },
        artifacts: {
          discovery: "repository evidence",
          plan: "approved repair plan",
        },
        revision: {
          active: false,
          feedback: "",
          previous_artifact: "",
        },
        steps: {
          verify: {
            status: "failed",
            success: false,
            exit_code: 1,
            output: "test failure",
          },
        },
        run: {
          id: "20260827-120000-a1b2c3d4",
          workflow: "custom-verified-workflow",
          status: "running",
        },
      }),
    ).not.toThrow();
  });

  test("keeps investigate read-only and all defaults provider-neutral", async () => {
    const config = await loadConfig(paths.configFile);
    const workflows = (await loadWorkflowCatalog(paths.workflowsDir)).map(
      ({ workflow }) => workflow,
    );
    const commands = await loadDefaultCommands();
    const investigate = requireWorkflow(workflows, "investigate");
    const investigateStep = investigate.steps[0];

    expect(config.models).toEqual({});
    expect(config.defaults?.model).toBeUndefined();
    expect(investigate.steps).toHaveLength(1);
    expect(investigateStep).toMatchObject({
      id: "investigate",
      uses: "agent",
      command: "investigate",
    });
    for (const name of ["discover", "plan", "review", "investigate"]) {
      expect(requireCommand(commands, name).metadata.tools).toEqual(
        READ_ONLY_TOOLS,
      );
    }
    expect(requireCommand(commands, "plan").prompt).toContain(
      "revise the previous implementation plan according to the human feedback",
    );
    for (const name of ["implement", "repair"]) {
      expect(requireCommand(commands, name).metadata.tools).toEqual(
        MUTATION_TOOLS,
      );
    }
    expect(requireCommand(commands, "summary").metadata.tools).toEqual([]);

    for (const command of commands.values()) {
      expect(command.metadata.model).toBeUndefined();
    }

    for (const workflow of workflows) {
      for (const step of flattenWorkflowSteps(workflow)) {
        if (step.uses === "agent") {
          expect(step.model).toBeUndefined();
        }
      }
    }
  });
});
