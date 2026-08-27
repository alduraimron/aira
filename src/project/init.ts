import { lstat, mkdir, writeFile } from "node:fs/promises";

import { AiraProjectError } from "./discovery";
import { getAiraProjectPaths, type AiraProjectPaths } from "./paths";

export const STARTER_CONFIG = `defaults:
  agent_timeout: 900
  shell_timeout: 300
  technical_retries: 1

commands: {}
models: {}
`;

export interface InitializeAiraProjectResult {
  paths: AiraProjectPaths;
  created: boolean;
}

export async function initializeAiraProject(
  root: string,
): Promise<InitializeAiraProjectResult> {
  const paths = getAiraProjectPaths(root);

  try {
    const existing = await lstat(paths.airaDir);

    if (existing.isDirectory()) {
      return { paths, created: false };
    }

    throw new AiraProjectError(
      `cannot initialize Aira because "${paths.airaDir}" is not a directory`,
    );
  } catch (cause) {
    if (cause instanceof AiraProjectError) {
      throw cause;
    }

    if (!isMissingPathError(cause)) {
      throw new AiraProjectError(
        `could not inspect "${paths.airaDir}": ${getErrorMessage(cause)}`,
        { cause },
      );
    }
  }

  try {
    await mkdir(paths.airaDir);
    await Promise.all([
      mkdir(paths.workflowsDir),
      mkdir(paths.commandsDir),
      mkdir(paths.runsDir),
    ]);
    await writeFile(paths.configFile, STARTER_CONFIG, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (cause) {
    throw new AiraProjectError(
      `could not initialize Aira in "${paths.root}": ${getErrorMessage(cause)}`,
      { cause },
    );
  }

  return { paths, created: true };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
