import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import type { ZodIssue } from "zod";

import { configSchema } from "./schema";
import type { AiraConfig } from "./types";
import {
  ConfigValidationError,
  type ConfigValidationIssue,
  validateConfig,
} from "./validator";

export async function loadConfig(filePath: string): Promise<AiraConfig> {
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ConfigValidationError(
      [{ message: `could not read config file: ${getErrorMessage(error)}` }],
      filePath,
      { cause: error },
    );
  }

  let document: unknown;

  try {
    document = parseYaml(source);
  } catch (error) {
    throw new ConfigValidationError(
      [{ message: `YAML syntax error: ${getErrorMessage(error)}` }],
      filePath,
      { cause: error },
    );
  }

  const result = configSchema.safeParse(document);

  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.flatMap(formatSchemaIssue),
      filePath,
      { cause: result.error },
    );
  }

  return validateConfig(result.data, filePath);
}

function formatSchemaIssue(issue: ZodIssue): ConfigValidationIssue[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: formatSchemaPath([...issue.path, key]),
      message: `unknown property "${key}"`,
    }));
  }

  if (issue.code === "invalid_key") {
    return issue.issues.map((keyIssue) => ({
      path: formatSchemaPath(issue.path),
      message: keyIssue.message,
    }));
  }

  return [
    {
      path: formatSchemaPath(issue.path),
      message: issue.message,
    },
  ];
}

function formatSchemaPath(parts: readonly PropertyKey[]): string {
  let result = "config";

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
