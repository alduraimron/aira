import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadWorkflow,
  WorkflowValidationError,
} from "../../src/workflow";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-workflow-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function writeWorkflow(contents: string): Promise<string> {
  const filePath = path.join(directory, "workflow.yaml");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

async function getLoadError(filePath: string): Promise<WorkflowValidationError> {
  try {
    await loadWorkflow(filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowValidationError);
    return error as WorkflowValidationError;
  }

  throw new Error("expected workflow loading to fail");
}

describe("workflow loader", () => {
  test("loads a valid feature-style workflow and preserves template strings", async () => {
    const filePath = await writeWorkflow(`
name: feature
description: Safely implement a new feature

inputs:
  task:
    required: true

steps:
  - id: discover
    uses: agent
    command: discover
    artifact:
      name: discovery
      filename: reports/discovery.md

  - id: plan
    uses: agent
    command: plan
    artifact:
      name: plan
      filename: plan.md
      versioned: true

  - id: approve-plan
    uses: approval
    artifact: plan
    message: Approve this implementation plan?
    revise: plan

  - id: implement
    uses: agent
    command: implement
    artifact:
      name: implementation
      filename: implementation-summary.md

  - id: verify-cycle
    uses: loop
    max_attempts: 3
    until: "steps.verify.success == true"
    steps:
      - id: verify
        uses: shell
        commands:
          - name: test
            run: "{{ config.commands.test }}"
          - name: typecheck
            run: "{{ config.commands.typecheck }}"

      - id: repair
        uses: agent
        command: repair
        when: "steps.verify.success == false"

  - id: review
    uses: agent
    command: review
    artifact:
      name: review
      filename: review.md

  - id: summary
    uses: agent
    command: summary
    artifact:
      name: summary
      filename: summary.md
`);

    const workflow = await loadWorkflow(filePath);

    expect(workflow.name).toBe("feature");
    expect(workflow.inputs).toEqual({ task: { required: true } });
    expect(workflow.steps).toHaveLength(7);
    expect(workflow.steps[0]).toMatchObject({
      artifact: {
        name: "discovery",
        filename: "reports/discovery.md",
        versioned: false,
      },
    });

    const loop = workflow.steps[4];
    expect(loop?.uses).toBe("loop");

    if (loop?.uses !== "loop") {
      throw new Error("expected loop step");
    }

    expect(loop.steps[0]).toMatchObject({
      commands: [
        { name: "test", run: "{{ config.commands.test }}" },
        { name: "typecheck", run: "{{ config.commands.typecheck }}" },
      ],
    });
  });

  test("reports malformed YAML with the workflow file", async () => {
    const filePath = await writeWorkflow("name: [unterminated\nsteps: []\n");
    const error = await getLoadError(filePath);

    expect(error.filePath).toBe(filePath);
    expect(error.message).toContain("YAML syntax error");
    expect(error.message).toContain(filePath);
  });

  test("reports structurally invalid YAML with an actionable path", async () => {
    const filePath = await writeWorkflow(`
name: feature
steps:
  - id: plan
    uses: agent
`);
    const error = await getLoadError(filePath);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("workflow.steps[0].command");
  });

  test("reports semantic workflow errors with the relevant step", async () => {
    const filePath = await writeWorkflow(`
name: checks
steps:
  - id: test
    uses: shell
    run: bun test
  - id: test
    uses: agent
    command: repair
`);
    const error = await getLoadError(filePath);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain('duplicate step ID "test"');
    expect(error.message).toContain('step "test"');
  });
});
