import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  AgentRuntime,
  AgentStepRequest,
  AgentStepResult,
} from "../../src/agent";

describe("agent runtime boundary", () => {
  test("accepts execution-ready provider-neutral requests", async () => {
    const seen: AgentStepRequest[] = [];
    const expected: AgentStepResult = {
      success: true,
      sessionId: "session-1",
      finalText: "finished",
      timedOut: false,
    };
    const runtime: AgentRuntime = {
      async runStep(request) {
        seen.push(request);
        return expected;
      },
    };
    const request: AgentStepRequest = {
      stepId: "plan",
      prompt: "Inspect the repository.",
      cwd: "/tmp/project",
      model: "anthropic/example-model",
      thinking: "high",
      tools: ["read", "grep", "find", "ls"],
      timeoutSeconds: 30,
      sessionLogPath: "/tmp/session.jsonl",
    };

    expect(await runtime.runStep(request)).toEqual(expected);
    expect(seen).toEqual([request]);
  });

  test("does not import workflow or run-state modules", async () => {
    const files = await listTypeScriptFiles(path.join(process.cwd(), "src/agent"));
    const source = (
      await Promise.all(files.map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(source).not.toMatch(/from\s+["'][^"']*workflow[^"']*["']/);
    expect(source).not.toMatch(/from\s+["'][^"']*run\/(?:state|types)[^"']*["']/);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(entryPath)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files;
}
