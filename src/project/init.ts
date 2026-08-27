import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_COMMANDS,
  DEFAULT_CONFIG,
  DEFAULT_WORKFLOWS,
} from "./defaults";
import { AiraProjectError } from "./discovery";
import { getAiraProjectPaths, type AiraProjectPaths } from "./paths";

export const STARTER_CONFIG = DEFAULT_CONFIG;

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
    await Promise.all([
      writeDefaultFile(paths.configFile, STARTER_CONFIG),
      ...Object.entries(DEFAULT_WORKFLOWS).map(([filename, source]) =>
        writeDefaultFile(path.join(paths.workflowsDir, filename), source),
      ),
      ...Object.entries(DEFAULT_COMMANDS).map(([filename, source]) =>
        writeDefaultFile(path.join(paths.commandsDir, filename), source),
      ),
    ]);
  } catch (cause) {
    throw new AiraProjectError(
      `could not initialize Aira in "${paths.root}": ${getErrorMessage(cause)}`,
      { cause },
    );
  }

  return { paths, created: true };
}

async function writeDefaultFile(
  filePath: string,
  source: string,
): Promise<void> {
  await writeFile(filePath, source, {
    encoding: "utf8",
    flag: "wx",
  });
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
