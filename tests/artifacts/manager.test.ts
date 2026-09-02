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

import {
  ArtifactError,
  getArtifactAbsolutePath,
  readArtifact,
  readArtifactVersion,
  writeArtifact,
} from "../../src/artifacts";
import { createRun, getRunPaths, loadRun } from "../../src/run";
import type { RunState } from "../../src/run";

let directory: string;
let runsRoot: string;
let state: RunState;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-artifact-"));
  runsRoot = path.join(directory, ".aira", "runs");
  state = await createRun({
    runsRoot,
    workflow: "feature",
    input: {},
    stepIds: ["discover", "plan"],
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function expectArtifactError(
  operation: () => Promise<unknown> | unknown,
): Promise<ArtifactError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactError);
    return error as ArtifactError;
  }

  throw new Error("expected artifact operation to fail");
}

describe("non-versioned artifacts", () => {
  test("writes, persists, resolves, and reads an artifact", async () => {
    const result = await writeArtifact({
      runsRoot,
      state,
      name: "discovery",
      filename: "discovery.md",
      versioned: false,
      content: "Repository discovery",
    });
    state = result.state;

    expect(result.path).toBe("artifacts/discovery.md");
    expect(state.artifacts.discovery).toEqual({
      current: "artifacts/discovery.md",
    });
    expect(
      getArtifactAbsolutePath({ runsRoot, state, name: "discovery" }),
    ).toBe(path.join(getRunPaths(runsRoot, state.id).artifactsDir, "discovery.md"));
    expect(await readArtifact({ runsRoot, state, name: "discovery" })).toBe(
      "Repository discovery",
    );
    expect((await loadRun(runsRoot, state.id)).artifacts.discovery).toEqual({
      current: "artifacts/discovery.md",
    });
  });

  test("overwrites the same path without adding versions", async () => {
    state = (
      await writeArtifact({
        runsRoot,
        state,
        name: "discovery",
        filename: "discovery.md",
        versioned: false,
        content: "First discovery",
      })
    ).state;

    const second = await writeArtifact({
      runsRoot,
      state,
      name: "discovery",
      filename: "discovery.md",
      versioned: false,
      content: "Updated discovery",
    });
    state = second.state;

    expect(second.path).toBe("artifacts/discovery.md");
    expect(state.artifacts.discovery).toEqual({
      current: "artifacts/discovery.md",
    });
    expect(state.artifacts.discovery?.versions).toBeUndefined();
    expect(await readArtifact({ runsRoot, state, name: "discovery" })).toBe(
      "Updated discovery",
    );
    expect(
      await readdir(getRunPaths(runsRoot, state.id).artifactsDir),
    ).toEqual(["discovery.md"]);
  });

  test("creates nested directories and preserves template-like content exactly", async () => {
    const content = `# Discovery

Task: {{ input.task }}
Artifact: {{ artifacts.plan }}

No interpolation here.\n`;
    const result = await writeArtifact({
      runsRoot,
      state,
      name: "discovery",
      filename: "reports/nested/discovery.md",
      versioned: false,
      content,
    });
    state = result.state;

    expect(result.path).toBe("artifacts/reports/nested/discovery.md");
    expect(await readArtifact({ runsRoot, state, name: "discovery" })).toBe(
      content,
    );
  });
});

describe("versioned artifacts", () => {
  test("writes ordered v1, v2, and v3 files and reads the latest", async () => {
    for (const [index, content] of ["Plan one", "Plan two", "Plan three"].entries()) {
      const result = await writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content,
      });
      state = result.state;
      expect(result.path).toBe(`artifacts/plan-v${index + 1}.md`);
    }

    expect(state.artifacts.plan).toEqual({
      current: "artifacts/plan-v3.md",
      versions: [
        "artifacts/plan-v1.md",
        "artifacts/plan-v2.md",
        "artifacts/plan-v3.md",
      ],
    });
    expect(await readArtifact({ runsRoot, state, name: "plan" })).toBe(
      "Plan three",
    );
    expect(
      await readArtifactVersion({
        runsRoot,
        state,
        name: "plan",
        path: "artifacts/plan-v1.md",
      }),
    ).toBe("Plan one");
    expect(
      await readArtifactVersion({
        runsRoot,
        state,
        name: "plan",
        path: "artifacts/plan-v2.md",
      }),
    ).toBe("Plan two");

    const artifactsDir = getRunPaths(runsRoot, state.id).artifactsDir;
    expect(await readFile(path.join(artifactsDir, "plan-v1.md"), "utf8")).toBe(
      "Plan one",
    );
    expect(await readFile(path.join(artifactsDir, "plan-v2.md"), "utf8")).toBe(
      "Plan two",
    );
    expect(await readFile(path.join(artifactsDir, "plan-v3.md"), "utf8")).toBe(
      "Plan three",
    );

    expect((await loadRun(runsRoot, state.id)).artifacts.plan).toEqual(
      state.artifacts.plan,
    );
  });

  test("inserts the version before the final extension in a nested filename", async () => {
    const result = await writeArtifact({
      runsRoot,
      state,
      name: "plan",
      filename: "nested/reports/plan.final.md",
      versioned: true,
      content: "Nested plan",
    });
    state = result.state;

    expect(result.path).toBe("artifacts/nested/reports/plan.final-v1.md");
    expect(await readArtifact({ runsRoot, state, name: "plan" })).toBe(
      "Nested plan",
    );
  });

  test("versions a filename without an extension", async () => {
    const first = await writeArtifact({
      runsRoot,
      state,
      name: "report",
      filename: "reports/report",
      versioned: true,
      content: "First report",
    });
    state = first.state;
    const second = await writeArtifact({
      runsRoot,
      state,
      name: "report",
      filename: "reports/report",
      versioned: true,
      content: "Second report",
    });
    state = second.state;

    expect(first.path).toBe("artifacts/reports/report-v1");
    expect(second.path).toBe("artifacts/reports/report-v2");
    expect(state.artifacts.report?.versions).toEqual([
      "artifacts/reports/report-v1",
      "artifacts/reports/report-v2",
    ]);
  });
});

describe("artifact validation", () => {
  test.each(["Plan", "plan_file", "plan.file", "-plan", ""])(
    "rejects invalid artifact name %p",
    async (name) => {
      const error = await expectArtifactError(() =>
        writeArtifact({
          runsRoot,
          state,
          name,
          filename: "plan.md",
          versioned: false,
          content: "Plan",
        }),
      );

      expect(error.message).toContain("Invalid artifact name");
    },
  );

  test.each([
    "/tmp/plan.md",
    "C:\\temp\\plan.md",
    "../plan.md",
    "nested/../../plan.md",
    "nested\\..\\plan.md",
    "plan\0.md",
  ])("rejects unsafe artifact filename %p", async (filename) => {
    const error = await expectArtifactError(() =>
      writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename,
        versioned: false,
        content: "Plan",
      }),
    );

    expect(error.message).toContain("Invalid artifact filename");
  });

  test("rejects an artifact version outside the persisted history", async () => {
    state = (
      await writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "Plan one",
      })
    ).state;

    const error = await expectArtifactError(() =>
      readArtifactVersion({
        runsRoot,
        state,
        name: "plan",
        path: "artifacts/plan-v2.md",
      }),
    );

    expect(error.message).toContain(
      "Artifact version is not present in run state",
    );
  });

  test("throws a clear error for a missing artifact", async () => {
    const error = await expectArtifactError(() =>
      readArtifact({ runsRoot, state, name: "missing" }),
    );

    expect(error.message).toContain("not present in run state");
    expect(error.message).toContain("missing");
    expect(error.message).toContain(state.id);
  });

  test("rejects a corrupted current path that escapes artifacts", async () => {
    const outsidePath = path.join(getRunPaths(runsRoot, state.id).root, "secret.md");
    await writeFile(outsidePath, "secret", "utf8");
    state = {
      ...state,
      artifacts: {
        discovery: { current: "artifacts/../secret.md" },
      },
    };

    const error = await expectArtifactError(() =>
      readArtifact({ runsRoot, state, name: "discovery" }),
    );

    expect(error.message).toContain("Artifact state is invalid");
  });

  test("rejects malformed versions whose current path is not last", async () => {
    state = {
      ...state,
      artifacts: {
        plan: {
          current: "artifacts/plan-v1.md",
          versions: ["artifacts/plan-v1.md", "artifacts/plan-v2.md"],
        },
      },
    };

    const error = await expectArtifactError(() =>
      writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "Plan three",
      }),
    );

    expect(error.message).toContain("Artifact state is invalid");
    expect(error.message).toContain("last version path");
  });

  test("rejects an empty persisted versions list", async () => {
    state = {
      ...state,
      artifacts: {
        plan: {
          current: "artifacts/plan-v1.md",
          versions: [],
        },
      },
    };

    const error = await expectArtifactError(() =>
      writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "Plan",
      }),
    );

    expect(error.message).toContain("Artifact state is invalid");
  });

  test("rejects version history that does not match the declared filename", async () => {
    state = {
      ...state,
      artifacts: {
        plan: {
          current: "artifacts/other-v1.md",
          versions: ["artifacts/other-v1.md"],
        },
      },
    };

    const error = await expectArtifactError(() =>
      writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "Next plan",
      }),
    );

    expect(error.message).toContain("version history is inconsistent");
  });

  test("rejects switching an artifact between versioning modes", async () => {
    state = (
      await writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "Versioned plan",
      })
    ).state;

    const error = await expectArtifactError(() =>
      writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: false,
        content: "Non-versioned plan",
      }),
    );

    expect(error.message).toContain("previously written as versioned");
  });
});
