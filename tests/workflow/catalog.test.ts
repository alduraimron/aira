import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  flattenWorkflowStepIds,
  loadNamedWorkflow,
  loadWorkflowCatalog,
  WorkflowCatalogError,
  WorkflowValidationError,
  type Workflow,
} from "../../src/workflow";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-workflow-catalog-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function writeWorkflow(filename: string, source: string): Promise<void> {
  await writeFile(path.join(directory, filename), source.trimStart(), "utf8");
}

describe("workflow catalog", () => {
  test("loads yaml and yml files sorted by declared workflow name", async () => {
    await writeWorkflow(
      "z-file.yaml",
      `name: alpha\ndescription: First workflow\nsteps:\n  - id: one\n    uses: shell\n    run: one\n`,
    );
    await writeWorkflow(
      "a-file.yml",
      `name: zulu\ndescription: Last workflow\nsteps:\n  - id: two\n    uses: shell\n    run: two\n`,
    );
    await writeWorkflow("ignored.json", "{}");

    const catalog = await loadWorkflowCatalog(directory);

    expect(catalog.map((entry) => entry.workflow.name)).toEqual([
      "alpha",
      "zulu",
    ]);
    expect(catalog.map((entry) => entry.workflow.description)).toEqual([
      "First workflow",
      "Last workflow",
    ]);
    expect((await loadNamedWorkflow(directory, "alpha")).workflow.name).toBe(
      "alpha",
    );
  });

  test("does not recurse into nested directories", async () => {
    await mkdir(path.join(directory, "nested"));
    await writeFile(
      path.join(directory, "nested", "hidden.yaml"),
      "name: hidden\nsteps:\n  - id: x\n    uses: shell\n    run: x\n",
      "utf8",
    );

    expect(await loadWorkflowCatalog(directory)).toEqual([]);
  });

  test("fails clearly for an invalid workflow file", async () => {
    await writeWorkflow(
      "broken.yaml",
      "name: broken\nsteps:\n  - id: missing-command\n    uses: agent\n",
    );

    await expect(loadWorkflowCatalog(directory)).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
  });

  test("rejects duplicate declared workflow names", async () => {
    const source =
      "name: duplicate\nsteps:\n  - id: one\n    uses: shell\n    run: one\n";
    await writeWorkflow("one.yaml", source);
    await writeWorkflow("two.yml", source);

    await expect(loadWorkflowCatalog(directory)).rejects.toThrow(
      'duplicate workflow "duplicate"',
    );
  });

  test("rejects invalid or missing requested names", async () => {
    await expect(loadNamedWorkflow(directory, "../feature")).rejects.toBeInstanceOf(
      WorkflowCatalogError,
    );
    await expect(loadNamedWorkflow(directory, "feature")).rejects.toThrow(
      'workflow "feature" not found',
    );
  });
});

describe("workflow step flattening", () => {
  test("returns top-level and loop child IDs in declaration order", () => {
    const workflow: Workflow = {
      name: "flat",
      steps: [
        { id: "before", uses: "shell", run: "before" },
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            { id: "repair", uses: "agent", command: "repair" },
          ],
        },
        { id: "after", uses: "approval" },
      ],
    };

    expect(flattenWorkflowStepIds(workflow)).toEqual([
      "before",
      "cycle",
      "verify",
      "repair",
      "after",
    ]);
  });
});
