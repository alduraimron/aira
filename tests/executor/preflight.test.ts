import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { preflightWorkflow } from "../../src/executor";
import type { Workflow } from "../../src/workflow";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-preflight-"));
  await mkdir(path.join(directory, "commands"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function writeCommand(name: string, source: string): Promise<void> {
  await writeFile(path.join(directory, "commands", `${name}.md`), source, "utf8");
}

describe("workflow preflight", () => {
  test("loads top-level and loop commands and resolves existing precedence", async () => {
    await writeCommand("plan", "---\nmodel: command\n---\nPlan.");
    await writeCommand("repair", "Repair.");
    const workflow: Workflow = {
      name: "feature",
      steps: [
        { id: "plan", uses: "agent", command: "plan", model: "step" },
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.repair.success == true",
          steps: [{ id: "repair", uses: "agent", command: "repair" }],
        },
      ],
    };

    const result = await preflightWorkflow({
      workflow,
      commandsDir: path.join(directory, "commands"),
      config: {
        models: {
          step: "provider/step",
          command: "provider/command",
        },
      },
    });

    expect([...result.agentSteps.keys()]).toEqual(["plan", "repair"]);
    expect(result.agentSteps.get("plan")?.configuration.model).toBe(
      "provider/step",
    );
  });

  test("rejects an unknown explicit workflow model alias", async () => {
    await writeCommand("plan", "Plan.");
    const workflow: Workflow = {
      name: "feature",
      steps: [
        { id: "plan", uses: "agent", command: "plan", model: "missing" },
      ],
    };

    await expect(
      preflightWorkflow({
        workflow,
        commandsDir: path.join(directory, "commands"),
        config: { models: {} },
      }),
    ).rejects.toThrow('workflow model alias "missing" is not defined');
  });

  test("rejects an unknown command model even when a step override wins", async () => {
    await writeCommand("plan", "---\nmodel: missing\n---\nPlan.");
    const workflow: Workflow = {
      name: "feature",
      steps: [
        { id: "plan", uses: "agent", command: "plan", model: "known" },
      ],
    };

    await expect(
      preflightWorkflow({
        workflow,
        commandsDir: path.join(directory, "commands"),
        config: { models: { known: "provider/model" } },
      }),
    ).rejects.toThrow('command "plan" model alias "missing" is not defined');
  });

  test("fails a malformed command before execution", async () => {
    await writeCommand("plan", "---\ntools: [read\n---\nPlan.");
    const workflow: Workflow = {
      name: "feature",
      steps: [{ id: "plan", uses: "agent", command: "plan" }],
    };

    await expect(
      preflightWorkflow({
        workflow,
        commandsDir: path.join(directory, "commands"),
        config: {},
      }),
    ).rejects.toThrow("YAML syntax error");
  });
});
