import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CommandValidationError,
  parseCommandMarkdown,
} from "./parser";
import { COMMAND_IDENTIFIER_PATTERN } from "./schema";
import type { AgentCommand } from "./types";

export async function loadCommand(filePath: string): Promise<AgentCommand> {
  if (path.extname(filePath) !== ".md") {
    throw new CommandValidationError(
      [
        {
          path: "command.filePath",
          message: 'command file must use the ".md" extension',
        },
      ],
      filePath,
    );
  }

  const name = path.basename(filePath, ".md");

  if (!COMMAND_IDENTIFIER_PATTERN.test(name)) {
    throw new CommandValidationError(
      [
        {
          path: "command.name",
          message:
            `command name "${name}" must match ` +
            COMMAND_IDENTIFIER_PATTERN.source,
        },
      ],
      filePath,
    );
  }

  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CommandValidationError(
      [{ message: `could not read command file: ${getErrorMessage(error)}` }],
      filePath,
      { cause: error },
    );
  }

  const parsed = parseCommandMarkdown(source, filePath);

  return {
    name,
    metadata: parsed.metadata,
    prompt: parsed.prompt,
    filePath,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
