import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommandValidationError,
  loadCommand,
} from "../../src/commands";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-command-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function writeCommand(name: string, contents: string): Promise<string> {
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

async function getLoadError(filePath: string): Promise<CommandValidationError> {
  try {
    await loadCommand(filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(CommandValidationError);
    return error as CommandValidationError;
  }

  throw new Error("expected command loading to fail");
}

describe("command loader", () => {
  test("loads a valid hyphenated command filename", async () => {
    const filePath = await writeCommand(
      "fix-tests.md",
      `---
description: Fix failing tests
model: coding
retry: 0
tools:
  - read
  - grep
---

Fix the tests for:

{{ input.task }}
`,
    );

    expect(await loadCommand(filePath)).toEqual({
      name: "fix-tests",
      metadata: {
        description: "Fix failing tests",
        model: "coding",
        retry: 0,
        tools: ["read", "grep"],
      },
      prompt: "Fix the tests for:\n\n{{ input.task }}",
      filePath,
    });
  });

  test("loads a command without frontmatter", async () => {
    const filePath = await writeCommand("discover.md", "Inspect the repository.\n");

    expect(await loadCommand(filePath)).toEqual({
      name: "discover",
      metadata: {},
      prompt: "Inspect the repository.",
      filePath,
    });
  });

  test("wraps file read errors with the command path", async () => {
    const filePath = path.join(directory, "missing.md");
    const error = await getLoadError(filePath);

    expect(error.filePath).toBe(filePath);
    expect(error.message).toContain(filePath);
    expect(error.message).toContain("could not read command file");
  });

  test("rejects a non-Markdown file", async () => {
    const filePath = await writeCommand("plan.txt", "Create a plan.");
    const error = await getLoadError(filePath);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain('".md" extension');
  });

  test.each(["Plan.md", "_plan.md", "fix_tests.md", "foo.bar.md"])(
    "rejects invalid command filename %p",
    async (filename) => {
      const filePath = await writeCommand(filename, "Prompt.");
      const error = await getLoadError(filePath);

      expect(error.message).toContain(filePath);
      expect(error.message).toContain("command.name");
      expect(error.message).toContain("must match");
    },
  );

  test("wraps prompt validation errors with the command file", async () => {
    const filePath = await writeCommand("plan.md", "   \n");
    const error = await getLoadError(filePath);

    expect(error.filePath).toBe(filePath);
    expect(error.message).toContain(filePath);
    expect(error.message).toContain("command prompt must not be empty");
  });
});
