import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadWorkflow } from "./loader";
import type { Workflow } from "./types";
import { WORKFLOW_IDENTIFIER_PATTERN } from "./validator";

export interface WorkflowCatalogEntry {
  filePath: string;
  workflow: Workflow;
}

export class WorkflowCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowCatalogError";
  }
}

/** Loads top-level .yaml and .yml workflow files in deterministic filename order. */
export async function loadWorkflowCatalog(
  workflowsDir: string,
): Promise<WorkflowCatalogEntry[]> {
  let entries;

  try {
    entries = await readdir(workflowsDir, { withFileTypes: true });
  } catch (cause) {
    throw new WorkflowCatalogError(
      `could not read workflows directory "${workflowsDir}": ${getErrorMessage(cause)}`,
      { cause },
    );
  }

  const filenames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (path.extname(entry.name) === ".yaml" ||
          path.extname(entry.name) === ".yml"),
    )
    .map((entry) => entry.name)
    .sort(compareStrings);
  const loaded: WorkflowCatalogEntry[] = [];
  const names = new Map<string, string>();

  for (const filename of filenames) {
    const filePath = path.join(workflowsDir, filename);
    const workflow = await loadWorkflow(filePath);
    const firstPath = names.get(workflow.name);

    if (firstPath !== undefined) {
      throw new WorkflowCatalogError(
        `duplicate workflow "${workflow.name}" in "${firstPath}" and "${filePath}"`,
      );
    }

    names.set(workflow.name, filePath);
    loaded.push({ filePath, workflow });
  }

  return loaded.sort((left, right) =>
    compareStrings(left.workflow.name, right.workflow.name),
  );
}

export async function loadNamedWorkflow(
  workflowsDir: string,
  name: string,
): Promise<WorkflowCatalogEntry> {
  if (!WORKFLOW_IDENTIFIER_PATTERN.test(name)) {
    throw new WorkflowCatalogError(
      `workflow name "${name}" must match ${WORKFLOW_IDENTIFIER_PATTERN.source}`,
    );
  }

  const catalog = await loadWorkflowCatalog(workflowsDir);
  const entry = catalog.find((candidate) => candidate.workflow.name === name);

  if (entry === undefined) {
    const filenameMatch = catalog.find((candidate) => {
      const extension = path.extname(candidate.filePath);
      return path.basename(candidate.filePath, extension) === name;
    });

    if (filenameMatch !== undefined) {
      throw new WorkflowCatalogError(
        `workflow file "${filenameMatch.filePath}" declares name ` +
          `"${filenameMatch.workflow.name}", expected "${name}"`,
      );
    }

    throw new WorkflowCatalogError(`workflow "${name}" not found`);
  }

  return entry;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
