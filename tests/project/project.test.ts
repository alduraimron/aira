import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config";
import {
  discoverAiraProject,
  findAiraProjectRoot,
  getAiraProjectPaths,
  initializeAiraProject,
} from "../../src/project";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-project-cli-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("Aira project discovery", () => {
  test("finds .aira in the current directory", async () => {
    const paths = getAiraProjectPaths(directory);
    await mkdir(paths.airaDir);

    expect(await findAiraProjectRoot(directory)).toBe(directory);
    expect(await discoverAiraProject(directory)).toEqual(paths);
  });

  test("walks upward from a nested directory", async () => {
    const paths = getAiraProjectPaths(directory);
    const nested = path.join(directory, "src", "feature", "deep");
    await Promise.all([
      mkdir(paths.airaDir),
      mkdir(nested, { recursive: true }),
    ]);

    expect(await findAiraProjectRoot(nested)).toBe(directory);
    expect((await discoverAiraProject(nested)).root).toBe(directory);
  });

  test("reports a missing project", async () => {
    await expect(discoverAiraProject(directory)).rejects.toThrow(
      'no .aira project found; run "aira init"',
    );
  });

  test("stops at the filesystem root", async () => {
    const filesystemRoot = path.parse(directory).root;
    expect(await findAiraProjectRoot(filesystemRoot)).toBeUndefined();
  });
});

describe("Aira project initialization", () => {
  test("creates the project layout and a valid starter config", async () => {
    const result = await initializeAiraProject(directory);

    expect(result.created).toBe(true);

    for (const target of [
      result.paths.airaDir,
      result.paths.workflowsDir,
      result.paths.commandsDir,
      result.paths.runsDir,
    ]) {
      expect((await stat(target)).isDirectory()).toBe(true);
    }

    expect((await stat(result.paths.configFile)).isFile()).toBe(true);
    expect(await loadConfig(result.paths.configFile)).toEqual({
      models: {},
      defaults: {
        agent_timeout: 900,
        shell_timeout: 300,
        technical_retries: 1,
      },
      commands: {},
    });
    expect((await readdir(result.paths.workflowsDir)).sort()).toEqual([
      "bugfix.yaml",
      "feature.yaml",
      "investigate.yaml",
    ]);
    expect((await readdir(result.paths.commandsDir)).sort()).toEqual([
      "discover.md",
      "implement.md",
      "investigate.md",
      "plan.md",
      "repair.md",
      "review.md",
      "summary.md",
    ]);
    expect(await readdir(result.paths.runsDir)).toEqual([]);
  });

  test("is idempotent and does not overwrite existing project files", async () => {
    const first = await initializeAiraProject(directory);
    const workflowPath = path.join(first.paths.workflowsDir, "feature.yaml");
    const commandPath = path.join(first.paths.commandsDir, "discover.md");
    const runMarker = path.join(first.paths.runsDir, "keep.txt");
    const customConfig = "commands:\n  test: custom test\n";
    const customWorkflow = "custom feature workflow";
    const customCommand = "custom discovery prompt";
    await Promise.all([
      writeFile(first.paths.configFile, customConfig, "utf8"),
      writeFile(workflowPath, customWorkflow, "utf8"),
      writeFile(commandPath, customCommand, "utf8"),
      writeFile(runMarker, "keep run", "utf8"),
    ]);

    const second = await initializeAiraProject(directory);

    expect(second.created).toBe(false);
    expect(await readFile(first.paths.configFile, "utf8")).toBe(customConfig);
    expect(await readFile(workflowPath, "utf8")).toBe(customWorkflow);
    expect(await readFile(commandPath, "utf8")).toBe(customCommand);
    expect(await readFile(runMarker, "utf8")).toBe("keep run");
  });
});
