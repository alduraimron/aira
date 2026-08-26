import { parse as parseYaml } from "yaml";
import type { ZodIssue } from "zod";

import { commandMetadataSchema } from "./schema";
import type { ParsedCommandMarkdown } from "./types";

const FRONTMATTER_DELIMITER_PATTERN = /^---(?:\r\n|\n|$)/m;

export interface CommandValidationIssue {
  message: string;
  path?: string;
}

export class CommandValidationError extends Error {
  readonly filePath?: string;
  readonly issues: readonly CommandValidationIssue[];

  constructor(
    issues: readonly CommandValidationIssue[],
    filePath?: string,
    options?: ErrorOptions,
  ) {
    const heading = filePath
      ? `Command validation failed for "${filePath}"`
      : "Command validation failed";
    const details = issues.map(formatIssue).map((issue) => `- ${issue}`);

    super(`${heading}:\n${details.join("\n")}`, options);
    this.name = "CommandValidationError";
    this.filePath = filePath;
    this.issues = issues;
  }
}

export function parseCommandMarkdown(
  source: string,
  filePath?: string,
): ParsedCommandMarkdown {
  const openingDelimiter = FRONTMATTER_DELIMITER_PATTERN.exec(source);
  let metadataDocument: unknown = {};
  let promptSource = source;
  let hasFrontmatter = false;

  if (openingDelimiter?.index === 0) {
    hasFrontmatter = true;
    const afterOpening = source.slice(openingDelimiter[0].length);
    const closingDelimiter = FRONTMATTER_DELIMITER_PATTERN.exec(afterOpening);

    if (!closingDelimiter) {
      throw new CommandValidationError(
        [
          {
            path: "frontmatter",
            message: 'frontmatter is not closed with a "---" delimiter',
          },
        ],
        filePath,
      );
    }

    const frontmatterSource = afterOpening.slice(0, closingDelimiter.index);
    promptSource = afterOpening.slice(
      closingDelimiter.index + closingDelimiter[0].length,
    );

    try {
      metadataDocument =
        frontmatterSource.trim().length === 0
          ? {}
          : parseYaml(frontmatterSource);
    } catch (error) {
      throw new CommandValidationError(
        [
          {
            path: "frontmatter",
            message: `YAML syntax error: ${getErrorMessage(error)}`,
          },
        ],
        filePath,
        { cause: error },
      );
    }
  }

  const metadataResult = commandMetadataSchema.safeParse(metadataDocument);

  if (!metadataResult.success) {
    throw new CommandValidationError(
      metadataResult.error.issues.flatMap(formatSchemaIssue),
      filePath,
      { cause: metadataResult.error },
    );
  }

  const prompt = normalizePrompt(promptSource, hasFrontmatter);

  if (prompt.trim().length === 0) {
    throw new CommandValidationError(
      [{ path: "prompt", message: "command prompt must not be empty" }],
      filePath,
    );
  }

  return {
    metadata: metadataResult.data,
    prompt,
  };
}

function normalizePrompt(source: string, hasFrontmatter: boolean): string {
  const withoutLeadingBlankLines = hasFrontmatter
    ? source.replace(/^(?:[\t ]*(?:\r\n|\n))+/, "")
    : source;

  return withoutLeadingBlankLines.trimEnd();
}

function formatSchemaIssue(issue: ZodIssue): CommandValidationIssue[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: formatSchemaPath([...issue.path, key]),
      message: `unknown metadata property "${key}"`,
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
  let result = "metadata";

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

function formatIssue(issue: CommandValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
