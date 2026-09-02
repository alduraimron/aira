import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRuntime,
  AgentStepRequest,
  AgentStepResult,
} from "../../src/agent";
import { runCli } from "../../src/cli";
import type { GitCommandRunner } from "../../src/git";
import { getAiraProjectPaths } from "../../src/project";
import { getRunPaths, listRunIds, loadRun } from "../../src/run";
import { TestCliIO } from "./helpers";

const nonGitRunner: GitCommandRunner = async () => ({
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository",
});

interface RecordingAgentRuntime extends AgentRuntime {
  readonly requests: AgentStepRequest[];
  readonly sessionIds: string[];
}

function createRecordingAgentRuntime(): RecordingAgentRuntime {
  const requests: AgentStepRequest[] = [];
  const sessionIds: string[] = [];
  const attempts = new Map<string, number>();

  return {
    requests,
    sessionIds,
    async runStep(request): Promise<AgentStepResult> {
      requests.push(request);
      const attempt = (attempts.get(request.stepId) ?? 0) + 1;
      attempts.set(request.stepId, attempt);
      const sessionId = `${request.stepId}-session-${attempt}`;
      sessionIds.push(sessionId);
      const expectedArtifacts = request.completion?.expectedArtifacts ?? [];

      return {
        success: true,
        sessionId,
        finalText: `Completed ${request.stepId} attempt ${attempt}.`,
        timedOut: false,
        completion: {
          status: "completed",
          summary: `${request.stepId} attempt ${attempt} completed`,
          artifacts: expectedArtifacts.map((name) => ({
            name,
            content: `# ${name}\n\n${request.stepId} attempt ${attempt}\n`,
          })),
        },
      };
    },
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-default-cli-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function initializeThroughCli(): Promise<void> {
  const io = new TestCliIO();
  const exitCode = await runCli(["init"], { cwd: directory, io });

  if (exitCode !== 0) {
    throw new Error(`aira init failed: ${io.error}`);
  }
}

function listedWorkflowNames(output: string): Array<string | undefined> {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.trim().split(/\s+/, 1)[0]);
}

describe("V1 default workflow smoke tests", () => {
  test("keeps a customized default file unchanged on a second init", async () => {
    await initializeThroughCli();
    const discoverPath = path.join(
      getAiraProjectPaths(directory).commandsDir,
      "discover.md",
    );
    const customPrompt = "Custom discovery for {{ input.task }}.\n";
    await writeFile(discoverPath, customPrompt, "utf8");
    const io = new TestCliIO();

    expect(await runCli(["init"], { cwd: directory, io })).toBe(0);
    expect(io.out).toContain("Aira is already initialized");
    expect(await readFile(discoverPath, "utf8")).toBe(customPrompt);
  });

  test("initializes, lists, dry-runs, approves, executes, persists artifacts, and reports status", async () => {
    const initIO = new TestCliIO();
    expect(await runCli(["init"], { cwd: directory, io: initIO })).toBe(0);
    expect(initIO.out).toContain("Initialized Aira");

    const listIO = new TestCliIO();
    expect(await runCli(["list"], { cwd: directory, io: listIO })).toBe(0);
    expect(listedWorkflowNames(listIO.out)).toEqual([
      "bugfix",
      "feature",
      "investigate",
    ]);

    const dryRunIO = new TestCliIO();
    expect(
      await runCli(
        ["run", "feature", "Implement JWT authentication", "--dry-run"],
        { cwd: directory, io: dryRunIO },
      ),
    ).toBe(0);
    expect(dryRunIO.out).toContain("Workflow: feature");
    expect(dryRunIO.out).toContain("discover  agent  command=discover");
    expect(dryRunIO.out).toContain(
      "approve-plan  approval  artifact=plan",
    );
    expect(dryRunIO.out).not.toContain("model=");

    const paths = getAiraProjectPaths(directory);
    expect(await readdir(paths.runsDir)).toEqual([]);

    const runtime = createRecordingAgentRuntime();
    const runIO = new TestCliIO(["approve"]);
    expect(
      await runCli(
        ["run", "feature", "Implement JWT authentication"],
        {
          cwd: directory,
          io: runIO,
          gitCommandRunner: nonGitRunner,
          agentRuntimeFactory: () => runtime,
        },
      ),
    ).toBe(0);
    expect(runIO.out).toContain("◆ approve-plan");
    expect(runIO.out).toContain("waiting for approval");
    expect(runIO.out).toContain("Approve this implementation plan?");
    expect(runIO.out).toContain("Run completed:");

    const runIds = await listRunIds(paths.runsDir);
    expect(runIds).toHaveLength(1);
    const runId = runIds[0] ?? "";
    const state = await loadRun(paths.runsDir, runId);
    const runPaths = getRunPaths(paths.runsDir, runId);

    expect(state.status).toBe("completed");
    expect(state.current_step).toBeUndefined();
    expect(state.steps["approve-plan"]).toMatchObject({
      status: "completed",
      result: "approved",
      success: true,
    });
    expect(state.artifacts).toEqual({
      discovery: { current: "artifacts/discovery.md" },
      plan: {
        current: "artifacts/plan-v1.md",
        versions: ["artifacts/plan-v1.md"],
      },
      implementation: {
        current: "artifacts/implementation-summary.md",
      },
      review: { current: "artifacts/review.md" },
      summary: { current: "artifacts/summary.md" },
    });

    expect(runtime.requests.map((request) => request.stepId)).toEqual([
      "discover",
      "plan",
      "implement",
      "review",
      "summary",
    ]);
    expect(new Set(runtime.sessionIds).size).toBe(5);
    expect(runtime.requests.every((request) => request.model === undefined))
      .toBe(true);
    expect(runtime.requests.every((request) => !request.prompt.includes("{{")))
      .toBe(true);

    const toolsByStep = new Map(
      runtime.requests.map((request) => [request.stepId, request.tools]),
    );
    expect(toolsByStep.get("discover")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "complete_step",
    ]);
    expect(toolsByStep.get("plan")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "complete_step",
    ]);
    expect(toolsByStep.get("implement")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "bash",
      "complete_step",
    ]);
    expect(toolsByStep.get("review")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "complete_step",
    ]);
    expect(toolsByStep.get("summary")).toEqual(["complete_step"]);

    for (const filename of [
      "discovery.md",
      "plan-v1.md",
      "implementation-summary.md",
      "review.md",
      "summary.md",
    ]) {
      expect(
        (await readFile(path.join(runPaths.artifactsDir, filename), "utf8"))
          .trim(),
      ).not.toBe("");
    }

    const statusIO = new TestCliIO();
    expect(
      await runCli(["status", runId], { cwd: directory, io: statusIO }),
    ).toBe(0);
    expect(statusIO.out).toContain(`Run:       ${runId}`);
    expect(statusIO.out).toContain("Workflow:  feature");
    expect(statusIO.out).toContain("Status:    completed");
  });

  test("revises the default plan to v2 before approval", async () => {
    await initializeThroughCli();
    const paths = getAiraProjectPaths(directory);
    const runtime = createRecordingAgentRuntime();
    const feedback =
      "Do not change PDF export. Add validator tests and rollback coverage.";
    const io = new TestCliIO(["revise", feedback, "approve"]);

    expect(
      await runCli(["run", "feature", "Implement JWT authentication"], {
        cwd: directory,
        io,
        gitCommandRunner: nonGitRunner,
        agentRuntimeFactory: () => runtime,
      }),
    ).toBe(0);

    const runId = (await listRunIds(paths.runsDir))[0] ?? "";
    const state = await loadRun(paths.runsDir, runId);
    const artifactsDir = getRunPaths(paths.runsDir, runId).artifactsDir;

    expect(runtime.requests.map((request) => request.stepId)).toEqual([
      "discover",
      "plan",
      "plan",
      "implement",
      "review",
      "summary",
    ]);
    const planRequests = runtime.requests.filter(
      (request) => request.stepId === "plan",
    );

    expect(state.status).toBe("completed");
    expect(state.input).toEqual({ task: "Implement JWT authentication" });
    expect(state.steps.plan).toMatchObject({
      status: "completed",
      attempt: 2,
      artifact: "artifacts/plan-v2.md",
    });
    expect(state.steps["approve-plan"]?.result).toBe("approved");
    expect(state.revisions).toEqual([
      {
        approval_step: "approve-plan",
        target_step: "plan",
        feedback,
        requested_at: expect.any(String),
        status: "resolved",
        previous_artifact: {
          name: "plan",
          path: "artifacts/plan-v1.md",
        },
        resolved_at: expect.any(String),
      },
    ]);
    expect(state.artifacts.plan).toEqual({
      current: "artifacts/plan-v2.md",
      versions: ["artifacts/plan-v1.md", "artifacts/plan-v2.md"],
    });
    expect(await readFile(path.join(artifactsDir, "plan-v1.md"), "utf8"))
      .toContain("plan attempt 1");
    expect(await readFile(path.join(artifactsDir, "plan-v2.md"), "utf8"))
      .toContain("plan attempt 2");
    expect(planRequests).toHaveLength(2);
    expect(planRequests[0]?.prompt).not.toContain(
      "This step is revising an artifact after human review.",
    );
    expect(planRequests[1]?.prompt).toContain(
      "This step is revising an artifact after human review.",
    );
    expect(planRequests[1]?.prompt).toContain(feedback);
    expect(planRequests[1]?.prompt).toContain(
      "# plan\n\nplan attempt 1",
    );
    expect(io.prompts).toHaveLength(3);
  });

  test("runs investigate with a read-only tool allowlist", async () => {
    await initializeThroughCli();
    const paths = getAiraProjectPaths(directory);
    const runtime = createRecordingAgentRuntime();
    const io = new TestCliIO();

    expect(
      await runCli(
        ["run", "investigate", "Explain the authentication flow"],
        {
          cwd: directory,
          io,
          gitCommandRunner: nonGitRunner,
          agentRuntimeFactory: () => runtime,
        },
      ),
    ).toBe(0);

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.stepId).toBe("investigate");
    expect(runtime.requests[0]?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "complete_step",
    ]);
    expect(runtime.requests[0]?.tools).not.toContain("edit");
    expect(runtime.requests[0]?.tools).not.toContain("write");
    expect(runtime.requests[0]?.tools).not.toContain("bash");

    const runId = (await listRunIds(paths.runsDir))[0] ?? "";
    const state = await loadRun(paths.runsDir, runId);
    expect(state.status).toBe("completed");
    expect(state.artifacts.investigation).toEqual({
      current: "artifacts/investigation.md",
    });
    expect(
      await readFile(
        path.join(
          getRunPaths(paths.runsDir, runId).artifactsDir,
          "investigation.md",
        ),
        "utf8",
      ),
    ).toContain("investigate attempt 1");
  });
});
