import { stat } from "node:fs/promises";
import path from "node:path";

import { getAiraProjectPaths, type AiraProjectPaths } from "./paths";

export class AiraProjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AiraProjectError";
  }
}

export async function findAiraProjectRoot(
  startDirectory: string,
): Promise<string | undefined> {
  let current = path.resolve(startDirectory);

  while (true) {
    const airaDir = path.join(current, ".aira");

    try {
      if ((await stat(airaDir)).isDirectory()) {
        return current;
      }
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        throw new AiraProjectError(
          `could not inspect "${airaDir}": ${getErrorMessage(cause)}`,
          { cause },
        );
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

export async function discoverAiraProject(
  startDirectory: string,
): Promise<AiraProjectPaths> {
  const root = await findAiraProjectRoot(startDirectory);

  if (root === undefined) {
    throw new AiraProjectError('no .aira project found; run "aira init"');
  }

  return getAiraProjectPaths(root);
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
