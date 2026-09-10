import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  readArtifact,
  readArtifactVersion,
} from "../../src/artifacts/manager";
import { RunStateError } from "../../src/run/errors";
import { loadRun } from "../../src/run/persistence";

const fixtureRoot = path.resolve(import.meta.dir, "../fixtures/legacy-v1");
const validRoot = path.join(fixtureRoot, "valid");
const invalidRoot = path.join(fixtureRoot, "invalid");

// Independent pin for the manifest itself (which cannot contain its own hash).
// Deliberately no snapshot updater, writers, schemas, or default builders here.
const manifestBytes = 6841;
const manifestSha256 =
  "1432976f99b8e8694c7ec7fe4caf8ea063df0a7a19529e40218f9d58b6031161";

interface FixtureManifest {
  format: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

const manifestSource = await readFile(path.join(fixtureRoot, "manifest.json"));
const manifest: FixtureManifest = JSON.parse(manifestSource.toString("utf8"));

// INV-LEGACY-003: check again after all reader calls, not only before them.
afterAll(async () => {
  expect(await readFile(path.join(fixtureRoot, "manifest.json"))).toEqual(manifestSource);
  for (const file of manifest.files) {
    const source = await readFile(path.join(fixtureRoot, file.path));
    expect(source.byteLength).toBe(file.bytes);
    expect(sha256(source)).toBe(file.sha256);
  }
});

// These are classifications of literal snapshots, never generated RunStates.
const validRuns = [
  ["completed shell", "20260826-100001-a1000001", "completed"],
  ["failed shell", "20260826-100002-a1000002", "failed"],
  ["cancelled approval", "20260826-100003-a1000003", "cancelled"],
  ["interrupted agent", "20260826-100004-a1000004", "interrupted"],
  ["waiting approval / one artifact version", "20260826-100005-a1000005", "waiting"],
  ["resolved revision / multiple versions", "20260826-100006-a1000006", "completed"],
  ["pending revision checkpoint", "20260826-100007-a1000007", "running"],
  ["non-versioned agent artifact", "20260826-100008-a1000008", "completed"],
  ["exhausted loop", "20260826-100009-a1000009", "waiting"],
] as const;

const invalidRuns = [
  ["malformed JSON", "20260826-110001-b1000001", ["invalid JSON"]],
  ["unsupported version", "20260826-110002-b1000002", ["run.version"]],
  ["directory identity mismatch", "20260826-110003-b1000003", ["does not match its directory"]],
  ["unknown top-level field", "20260826-110004-b1000004", ["Unrecognized key", "spec_generation"]],
  ["nested persisted loop steps", "20260826-110005-b1000005", ["run.steps.repair-loop", "Unrecognized key"]],
  ["invalid calendar date", "20260826-110006-b1000006", ["run.started_at", "valid ISO 8601 UTC"]],
  ["unsupported run status", "20260826-110007-b1000007", ["run.status"]],
  ["artifact traversal", "20260826-110008-b1000008", ["run.artifacts.plan.current", "normalized path inside"]],
  ["current is not last version", "20260826-110009-b1000009", ["current artifact path must equal the last version path"]],
  ["duplicate artifact version", "20260826-110010-b100000a", ["duplicate artifact version path"]],
  ["empty artifact versions", "20260826-110011-b100000b", ["run.artifacts.plan.versions", "Too small"]],
  ["resolved without timestamp", "20260826-110012-b100000c", ["resolved revision must have a resolution timestamp"]],
  ["pending with timestamp", "20260826-110013-b100000d", ["pending revision must not have a resolution timestamp"]],
  ["multiple pending revisions", "20260826-110014-b100000e", ["must not contain more than one pending revision"]],
  ["pending not latest", "20260826-110015-b100000f", ["a pending revision must be the latest revision record"]],
  ["blank revision feedback", "20260826-110016-b1000010", ["revision feedback must not be empty"]],
  ["empty revisions", "20260826-110017-b1000011", ["run.revisions", "Too small"]],
  ["negative attempt", "20260826-110018-b1000012", ["run.steps.verify.attempt", "Too small"]],
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inventory(relativeDirectory = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(fixtureRoot, relativeDirectory), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await inventory(relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Fixture must be a literal file, not a symlink: ${relativePath}`);
    }
  }

  return files.sort();
}

async function expectFrozenContent(
  relativePath: string,
  content: string,
): Promise<void> {
  const entry = manifest.files.find((file) => file.path === relativePath);
  if (entry === undefined) {
    throw new Error(`No frozen expectation for ${relativePath}`);
  }

  const bytes = Buffer.from(content, "utf8");
  expect(bytes.byteLength).toBe(entry.bytes);
  expect(sha256(bytes)).toBe(entry.sha256);
  expect(bytes).toEqual(await readFile(path.join(fixtureRoot, relativePath)));
}

describe("frozen legacy v1 bytes", () => {
  test("pins manifest bytes independently of its payload hashes", () => {
    expect(manifestSource.byteLength).toBe(manifestBytes);
    expect(sha256(manifestSource)).toBe(manifestSha256);
  });

  test("manifest covers every literal file once with normalized paths", async () => {
    expect(Object.keys(manifest).sort()).toEqual(["files", "format"]);
    expect(manifest.format).toBe(1);
    const files = (await inventory()).filter((file) => file !== "manifest.json");
    expect(manifest.files.map((file) => file.path)).toEqual(files);

    for (const file of manifest.files) {
      expect(Object.keys(file).sort()).toEqual(["bytes", "path", "sha256"]);
      expect(path.posix.isAbsolute(file.path)).toBe(false);
      expect(path.posix.normalize(file.path)).toBe(file.path);
      expect(file.path.split("/")).not.toContain("..");
      expect(file.path).not.toContain("\\");
      expect(Number.isSafeInteger(file.bytes)).toBe(true);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test.each(manifest.files.map((file) => [file.path, file.bytes, file.sha256] as const))(
    "preserves raw bytes: %s",
    async (relativePath, bytes, hash) => {
      const source = await readFile(path.join(fixtureRoot, relativePath));
      expect(source.byteLength).toBe(bytes);
      expect(sha256(source)).toBe(hash);
    },
  );

  test("every run fixture is classified and exercised, not silently skipped", async () => {
    const files = await inventory();
    expect(files.filter((file) => file.endsWith("/run.json"))).toEqual([
      ...invalidRuns.map(([, id]) => `invalid/${id}/run.json`),
      ...validRuns.map(([, id]) => `valid/${id}/run.json`),
    ].sort());
    expect(new Set(validRuns.map(([, , status]) => status))).toEqual(
      new Set(["running", "waiting", "completed", "failed", "cancelled", "interrupted"]),
    );
  });
});

describe("INV-LEGACY-001: read-only v1 history compatibility", () => {
  test.each(validRuns)(
    "%s loads directly without workflow/default regeneration",
    async (_label, id, status) => {
      const stateFile = path.join(validRoot, id, "run.json");
      const source = await readFile(stateFile);
      const state = await loadRun(validRoot, id);

      expect(state).toStrictEqual(JSON.parse(source.toString("utf8")));
      expect(state.version).toBe(1);
      expect(state.id).toBe(path.basename(path.dirname(stateFile)));
      expect(state.status).toBe(status);
      // INV-LEGACY-003: inspecting history must not rewrite the source.
      expect(await readFile(stateFile)).toEqual(source);
    },
  );

  test.each(validRuns)(
    "%s preserves readable current, historical, step, and revision artifact references",
    async (_label, id) => {
      const state = await loadRun(validRoot, id);
      const prefix = `valid/${id}/`;

      for (const [name, artifact] of Object.entries(state.artifacts)) {
        await expectFrozenContent(
          prefix + artifact.current,
          await readArtifact({ runsRoot: validRoot, state, name }),
        );
        for (const storedPath of artifact.versions ?? [artifact.current]) {
          await expectFrozenContent(
            prefix + storedPath,
            await readArtifactVersion({ runsRoot: validRoot, state, name, path: storedPath }),
          );
        }
      }

      for (const revision of state.revisions ?? []) {
        const previous = revision.previous_artifact;
        if (previous !== undefined) {
          await expectFrozenContent(
            prefix + previous.path,
            await readArtifactVersion({ runsRoot: validRoot, state, ...previous }),
          );
        }
      }

      for (const step of Object.values(state.steps)) {
        const storedPath = step.artifact;
        if (storedPath === undefined) {
          continue;
        }
        const reference = Object.entries(state.artifacts).find(([, artifact]) =>
          (artifact.versions ?? [artifact.current]).includes(storedPath),
        );
        if (reference === undefined) {
          throw new Error(`Unrepresented step artifact in ${id}: ${storedPath}`);
        }
        await expectFrozenContent(
          prefix + storedPath,
          await readArtifactVersion({
            runsRoot: validRoot,
            state,
            name: reference[0],
            path: storedPath,
          }),
        );
      }
    },
  );

  test("all captured artifacts are referenced by valid runs", async () => {
    const references = new Set<string>();
    for (const [, id] of validRuns) {
      const state = await loadRun(validRoot, id);
      for (const artifact of Object.values(state.artifacts)) {
        for (const storedPath of artifact.versions ?? [artifact.current]) {
          references.add(`valid/${id}/${storedPath}`);
        }
      }
    }
    expect([...references].sort()).toEqual(
      (await inventory()).filter((file) => file.includes("/artifacts/")),
    );
  });

  test("distinguishes one version, multiple versions, and omitted non-versioned history", async () => {
    const single = await loadRun(validRoot, "20260826-100005-a1000005");
    const multiple = await loadRun(validRoot, "20260826-100006-a1000006");
    const plain = await loadRun(validRoot, "20260826-100008-a1000008");
    expect(single.artifacts.plan?.versions).toEqual(["artifacts/plan-v1.md"]);
    expect(multiple.artifacts.plan?.versions).toEqual(["artifacts/plan-v1.md", "artifacts/plan-v2.md"]);
    expect(plain.artifacts.notes).toStrictEqual({ current: "artifacts/reports/note.md" });
    expect(plain.steps.note).toMatchObject({
      summary: "Recorded café compatibility notes.",
      artifact: "artifacts/reports/note.md",
      output: "Saved café notes.",
    });
  });

  test("preserves resolved feedback and the latest pending revision checkpoint", async () => {
    const resolved = await loadRun(validRoot, "20260826-100006-a1000006");
    expect(resolved.revisions).toHaveLength(1);
    expect(resolved.revisions?.[0]).toMatchObject({
      status: "resolved",
      feedback: "Do not change PDF export. Add rollback and validator checks.",
      resolved_at: "2026-08-26T10:04:06.000Z",
      previous_artifact: { name: "plan", path: "artifacts/plan-v1.md" },
    });
    // INV-LEGACY-002: a generic result stays generic, without invented actor/hash.
    expect(resolved.steps["approve-plan"]?.result).toBe("approved");

    const pending = await loadRun(validRoot, "20260826-100007-a1000007");
    expect(pending.current_step).toBe("plan");
    expect(pending.steps.plan).toStrictEqual({ status: "pending", attempt: 2 });
    expect(pending.revisions?.map((revision) => revision.status)).toEqual(["resolved", "pending"]);
    expect(pending.revisions?.at(-1)).not.toHaveProperty("resolved_at");
    expect(pending.revisions?.at(-1)?.previous_artifact?.path).toBe("artifacts/plan-v2.md");
  });

  test("waiting approval and waiting exhausted loop have distinct literal context", async () => {
    const approvalContext: unknown = parseYaml(await readFile(
      path.join(fixtureRoot, "workflows/legacy-review.yaml"), "utf8",
    ));
    const loopContext: unknown = parseYaml(await readFile(
      path.join(fixtureRoot, "workflows/legacy-loop.yaml"), "utf8",
    ));
    expect(approvalContext).toMatchObject({
      name: "legacy-review",
      steps: [
        { id: "plan", uses: "agent" },
        { id: "approve-plan", uses: "approval", revise: "plan", artifact: "plan" },
        { id: "verify", uses: "shell" },
      ],
    });
    expect(loopContext).toMatchObject({
      name: "legacy-loop",
      steps: [{
        id: "repair-loop", uses: "loop", max_attempts: 2,
        steps: [{ id: "check", uses: "shell" }, { id: "repair", uses: "agent" }],
      }],
    });
    const approval = await loadRun(validRoot, "20260826-100005-a1000005");
    const loop = await loadRun(validRoot, "20260826-100009-a1000009");
    expect(approval.steps["approve-plan"]).toStrictEqual({ status: "waiting", attempt: 0 });
    expect(loop.current_step).toBe("repair-loop");
    expect(Object.keys(loop.steps)).toEqual(["repair-loop", "check", "repair"]);
    expect(loop.steps["repair-loop"]).toMatchObject({ status: "waiting", attempt: 2, success: false });
    expect(loop.steps.check).toMatchObject({ status: "failed", attempt: 2, exit_code: 1 });
    expect(loop.steps.repair).toMatchObject({ status: "completed", attempt: 2, success: true });
  });

  test.each(invalidRuns)("rejects literal %s", async (_label, id, fragments) => {
    let failure: unknown;
    try {
      await loadRun(invalidRoot, id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RunStateError);
    if (!(failure instanceof RunStateError)) {
      throw new Error(`Expected a v1 rejection for ${id}`);
    }
    for (const fragment of fragments) {
      expect(failure.message).toContain(fragment);
    }
    expect(failure.message).toContain(path.join(invalidRoot, id, "run.json"));
  });
});
