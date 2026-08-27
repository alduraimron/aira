import { readdir } from "node:fs/promises";

import { RunStateError } from "./errors";
import { RUN_ID_PATTERN } from "./id";

/** Returns valid run directory IDs in newest-first lexical order. */
export async function listRunIds(runsRoot: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return [];
    }

    throw new RunStateError("Could not list runs", {
      filePath: runsRoot,
      cause,
    });
  }

  return entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
}

export async function findLatestRunId(
  runsRoot: string,
): Promise<string | undefined> {
  return (await listRunIds(runsRoot))[0];
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
