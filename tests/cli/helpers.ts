import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CliIO, SigintHandler, SigintSource } from "../../src/cli";
import { initializeAiraProject, type AiraProjectPaths } from "../../src/project";

export class TestCliIO implements CliIO {
  out = "";
  error = "";
  readonly prompts: string[] = [];
  readonly answers: Array<string | null>;

  constructor(answers: Array<string | null> = []) {
    this.answers = [...answers];
  }

  writeOut(message: string): void {
    this.out += message;
  }

  writeError(message: string): void {
    this.error += message;
  }

  async readLine(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    this.prompts.push(prompt);
    this.out += prompt;

    if (signal?.aborted === true) {
      return null;
    }

    return this.answers.shift() ?? null;
  }
}

export class TestSigintSource implements SigintSource {
  readonly handlers = new Set<SigintHandler>();
  addCalls = 0;
  removeCalls = 0;

  add(handler: SigintHandler): void {
    this.addCalls += 1;
    this.handlers.add(handler);
  }

  remove(handler: SigintHandler): void {
    this.removeCalls += 1;
    this.handlers.delete(handler);
  }

  emit(): void {
    for (const handler of [...this.handlers]) {
      handler();
    }
  }
}

export async function createTemporaryDirectory(
  prefix = "aira-cli-",
): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true });
}

/** Creates an initialized project with empty fixture directories. */
export async function createCliProject(
  root: string,
): Promise<AiraProjectPaths> {
  await mkdir(root, { recursive: true });
  const paths = (await initializeAiraProject(root)).paths;
  await Promise.all([
    clearDirectory(paths.workflowsDir),
    clearDirectory(paths.commandsDir),
  ]);
  return paths;
}

async function clearDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory);
  await Promise.all(
    entries.map((entry) =>
      rm(path.join(directory, entry), { force: true, recursive: true }),
    ),
  );
}

export async function writeWorkflowFixture(
  paths: AiraProjectPaths,
  filename: string,
  source: string,
): Promise<string> {
  const filePath = path.join(paths.workflowsDir, filename);
  await writeFile(filePath, source.trimStart(), "utf8");
  return filePath;
}

export async function writeCommandFixture(
  paths: AiraProjectPaths,
  name: string,
  source = "Perform the requested work.",
): Promise<string> {
  const filePath = path.join(paths.commandsDir, `${name}.md`);
  await writeFile(filePath, source, "utf8");
  return filePath;
}
