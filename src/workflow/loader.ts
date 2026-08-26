import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { workflowSchema } from "./schema";
import type { Workflow } from "./types";
import {
  validateWorkflow,
  WorkflowValidationError,
  type WorkflowValidationIssue,
} from "./validator";

export async function loadWorkflow(filePath: string): Promise<Workflow> {
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new WorkflowValidationError(
      [{ message: `could not read workflow file: ${getErrorMessage(error)}` }],
      filePath,
      { cause: error },
    );
  }

  let document: unknown;

  try {
    document = parseYaml(source);
  } catch (error) {
    throw new WorkflowValidationError(
      [{ message: `YAML syntax error: ${getErrorMessage(error)}` }],
      filePath,
      { cause: error },
    );
  }

  const result = workflowSchema.safeParse(document);

  if (!result.success) {
    const issues: WorkflowValidationIssue[] = result.error.issues.map((issue) => ({
      path: formatSchemaPath(issue.path),
      message: issue.message,
    }));

    throw new WorkflowValidationError(issues, filePath, {
      cause: result.error,
    });
  }

  return validateWorkflow(result.data, filePath);
}

function formatSchemaPath(parts: readonly PropertyKey[]): string {
  let result = "workflow";

  for (const part of parts) {
    if (typeof part === "number") {
      result += `[${part}]`;
      continue;
    }

    const key = String(part);

    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) {
      result += `.${key}`;
    } else {
      result += `[${JSON.stringify(key)}]`;
    }
  }

  return result;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
