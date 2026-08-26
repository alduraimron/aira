import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigValidationError, loadConfig } from "../../src/config";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-config-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function writeConfig(contents: string): Promise<string> {
  const filePath = path.join(directory, "config.yaml");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

async function getLoadError(filePath: string): Promise<ConfigValidationError> {
  try {
    await loadConfig(filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }

  throw new Error("expected config loading to fail");
}

describe("config loader", () => {
  test("loads a valid config", async () => {
    const filePath = await writeConfig(`
models:
  cheap: openai/gpt-5-mini
  coding: anthropic/claude-sonnet

defaults:
  model: coding
  agent_timeout: 900
  shell_timeout: 300
  technical_retries: 0

commands:
  test: bun test
  typecheck: bun run typecheck
`);

    expect(await loadConfig(filePath)).toEqual({
      models: {
        cheap: "openai/gpt-5-mini",
        coding: "anthropic/claude-sonnet",
      },
      defaults: {
        model: "coding",
        agent_timeout: 900,
        shell_timeout: 300,
        technical_retries: 0,
      },
      commands: {
        test: "bun test",
        typecheck: "bun run typecheck",
      },
    });
  });

  test("loads an empty YAML object", async () => {
    const filePath = await writeConfig("{}\n");
    expect(await loadConfig(filePath)).toEqual({});
  });

  test("wraps file read errors with the config path", async () => {
    const filePath = path.join(directory, "missing.yaml");
    const error = await getLoadError(filePath);

    expect(error.filePath).toBe(filePath);
    expect(error.message).toContain(filePath);
    expect(error.message).toContain("could not read config file");
  });

  test("reports malformed YAML with the config file", async () => {
    const filePath = await writeConfig("models: [unterminated\n");
    const error = await getLoadError(filePath);

    expect(error.filePath).toBe(filePath);
    expect(error.message).toContain(filePath);
    expect(error.message).toContain("YAML syntax error");
  });

  test("reports structural failures with the config path", async () => {
    const filePath = await writeConfig(`
defaults:
  agent_timeout: 0
`);
    const error = await getLoadError(filePath);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("config.defaults.agent_timeout");
  });

  test("reports unknown properties with their config path", async () => {
    const filePath = await writeConfig(`
defaults:
  unexpected: true
`);
    const error = await getLoadError(filePath);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("config.defaults.unexpected");
  });

  test("reports invalid aliases with the expected format", async () => {
    const filePath = await writeConfig(`
models:
  Smart: anthropic/claude-sonnet
`);
    const error = await getLoadError(filePath);

    expect(error.message).toContain("config.models.Smart");
    expect(error.message).toContain("alias must match ^[a-z][a-z0-9-]*$");
  });

  test("reports semantic failures with the config path", async () => {
    const filePath = await writeConfig(`
models:
  cheap: openai/gpt-5-mini
defaults:
  model: smart
`);
    const error = await getLoadError(filePath);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("config.defaults.model");
    expect(error.message).toContain(
      'model alias "smart" is not defined in config.models',
    );
  });
});
