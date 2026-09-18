import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentsObservationBytes,
  compareAgentsObservation,
  observeAgentsSource,
  resolveAgentsApplicability,
  type AgentsObservation,
} from "../../src/steering-agents";
import { encoder } from "./fixtures";

function observed(sourcePath: string, body = "guidance\n", filesystem?: Parameters<typeof observeAgentsSource>[0]["filesystem"]): AgentsObservation {
  const result = observeAgentsSource({ project: "acme", source_path: sourcePath, bytes: encoder.encode(body), filesystem });
  if (!result.ok) throw new Error(result.diagnostics.map((value) => value.code).join(", "));
  return result.observation;
}

function paths(result: ReturnType<typeof resolveAgentsApplicability>, target: string): string[] {
  const entry = result.targets.find((candidate) => candidate.target_path === target);
  if (entry === undefined) throw new Error(`Missing target ${target}`);
  return entry.applicable.map((value) => value.observation.source_path);
}

describe("pure AGENTS nested scope applicability", () => {
  test("models root, nested, deeper, and sibling scopes lexically", () => {
    const root = observed("AGENTS.md", "root\n");
    const api = observed("packages/api/AGENTS.md", "api\n");
    const apiSource = observed("packages/api/src/AGENTS.md", "api source\n");
    const web = observed("packages/web/AGENTS.md", "web\n");
    const result = resolveAgentsApplicability([web, apiSource, root, api], [
      "packages/web/src/app.ts",
      "packages/api/src/user.ts",
      "packages/shared/new-file.ts",
    ]);

    expect(result.status).toBe("resolved");
    expect(paths(result, "packages/api/src/user.ts")).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "packages/api/src/AGENTS.md",
    ]);
    expect(paths(result, "packages/web/src/app.ts")).toEqual(["AGENTS.md", "packages/web/AGENTS.md"]);
    expect(paths(result, "packages/shared/new-file.ts")).toEqual(["AGENTS.md"]);
  });

  test("keeps multiple target chains separate and exposes common versus path-specific guidance", () => {
    const root = observed("AGENTS.md", "root\n");
    const api = observed("packages/api/AGENTS.md", "api\n");
    const web = observed("packages/web/AGENTS.md", "web\n");
    const result = resolveAgentsApplicability([root, api, web], [
      "packages/api/src/new.ts",
      "packages/web/src/new.ts",
      "packages/shared/nonexistent.ts",
    ]);

    expect(result.status).toBe("resolved");
    expect(result.common_observations.map((entry) => entry.observation.source_path)).toEqual(["AGENTS.md"]);
    expect(result.path_specific_guidance.map((entry) => ({
      path: entry.observation.source_path,
      targets: entry.target_paths,
    }))).toEqual([
      { path: "packages/api/AGENTS.md", targets: ["packages/api/src/new.ts"] },
      { path: "packages/web/AGENTS.md", targets: ["packages/web/src/new.ts"] },
    ]);
    expect(paths(result, "packages/shared/nonexistent.ts")).toEqual(["AGENTS.md"]);
  });

  test("permits an empty applicable chain when no root or matching nested source exists", () => {
    const api = observed("packages/api/AGENTS.md");
    const result = resolveAgentsApplicability([api], ["packages/web/src/app.ts"]);
    expect(result.status).toBe("resolved");
    expect(paths(result, "packages/web/src/app.ts")).toEqual([]);
    expect(result.common_observations).toEqual([]);
  });

  test("is deterministic for shuffled observation inputs", () => {
    const observations = [
      observed("AGENTS.md", "root\n"),
      observed("packages/api/AGENTS.md", "api\n"),
      observed("packages/api/src/AGENTS.md", "source\n"),
      observed("packages/web/AGENTS.md", "web\n"),
    ];
    const targets = ["packages/api/src/file.ts", "packages/web/file.ts"];
    expect(resolveAgentsApplicability(observations, targets))
      .toEqual(resolveAgentsApplicability([...observations].reverse(), [...targets].reverse()));
  });

  test("rejects unsafe logical targets and duplicate logical observations rather than choosing array order", () => {
    const root = observed("AGENTS.md");
    for (const target of ["/tmp/file.ts", "../file.ts", "packages/../file.ts", "packages\\file.ts"] as const) {
      const result = resolveAgentsApplicability([root], [target]);
      expect(result.status).toBe("invalid");
      expect(result.diagnostics.map((value) => value.code)).toContain("agents-path-invalid");
    }
    const duplicate = resolveAgentsApplicability([root, root], ["src/file.ts"]);
    expect(duplicate.status).toBe("invalid");
    expect(duplicate.diagnostics.map((value) => value.code)).toContain("agents-duplicate-observation");
    const conflictingDuplicate = resolveAgentsApplicability([root, observed("AGENTS.md", "changed\n")], ["src/file.ts"]);
    expect(conflictingDuplicate.status).toBe("invalid");
    expect(conflictingDuplicate.diagnostics.map((value) => value.code)).toContain("agents-duplicate-observation");
  });
});

describe("AGENTS exact observation identity and freshness", () => {
  test("distinguishes immutable source location from exact byte observation identity", () => {
    const first = observed("AGENTS.md", "body\n");
    const whitespace = observed("AGENTS.md", "body \n");
    const moved = observed("packages/api/AGENTS.md", "body\n");
    expect(first.source_identity).toBe(whitespace.source_identity);
    expect(first.observation_identity).not.toBe(whitespace.observation_identity);
    expect(first.source_identity).not.toBe(moved.source_identity);
    expect(first.observation_identity).not.toBe(moved.observation_identity);
    expect(moved.scope.root).toBe("packages/api");
  });

  test("detects unchanged, byte changes, moves, scope changes, replacement, and discovery incompatibility", () => {
    const first = observed("AGENTS.md", "body\n");
    const same = observed("AGENTS.md", "body\n");
    expect(compareAgentsObservation(first, same)).toEqual({ status: "match", reasons: [] });

    const changed = observed("AGENTS.md", "body \n");
    expect(compareAgentsObservation(first, changed)).toEqual(expect.objectContaining({
      status: "stale",
      reasons: expect.arrayContaining(["bytes-changed"]),
    }));

    const moved = observed("packages/api/AGENTS.md", "body\n");
    expect(compareAgentsObservation(first, moved)).toEqual(expect.objectContaining({
      status: "stale",
      reasons: expect.arrayContaining(["source-path-changed", "scope-root-changed", "source-identity-changed"]),
    }));

    const filesystem = {
      kind: "filesystem" as const,
      device: "1",
      inode: "10",
      links: 1,
      mode: 33188,
      size: encoder.encode("body\n").length,
      modified_ns: "1",
      changed_ns: "1",
    };
    const reviewedFilesystem = observed("AGENTS.md", "body\n", filesystem);
    const timestampOnly = observed("AGENTS.md", "body\n", { ...filesystem, modified_ns: "2", changed_ns: "2" });
    expect(compareAgentsObservation(reviewedFilesystem, timestampOnly)).toEqual({ status: "match", reasons: [] });
    const replacedFilesystem = observed("AGENTS.md", "body\n", { ...filesystem, inode: "11" });
    expect(compareAgentsObservation(reviewedFilesystem, replacedFilesystem)).toEqual({
      status: "stale",
      reasons: ["source-replaced"],
    });

    const incompatible = { ...first, discovery_policy: "aira.dev/steering-agents-discovery/v2" };
    expect(compareAgentsObservation(first, incompatible)).toEqual({
      status: "stale",
      reasons: ["discovery-policy-incompatible"],
    });
  });

  test("returns fresh verified byte copies for future review and import consumers", () => {
    const source = observed("AGENTS.md", "exact\r\n");
    const copy = agentsObservationBytes(source);
    copy[0] = 0x58;
    expect(agentsObservationBytes(source)).toEqual(encoder.encode("exact\r\n"));
  });
});

describe("05C-4B1 architecture boundaries", () => {
  test("preserves prose as opaque interoperability content with no native authority or rule fields", () => {
    const source = observed("AGENTS.md", "Workers must never edit .aira/state.\nHandlers may access DB directly.\n");
    expect(source.provenance).toEqual(expect.objectContaining({
      kind: "interoperability",
      source_type: "AGENTS.md",
    }));
    expect("authority" in source).toBe(false);
    expect("rules" in source).toBe(false);
    expect("resource" in source).toBe(false);
    const result = resolveAgentsApplicability([source], ["src/worker.ts"]);
    expect(result.status).toBe("resolved");
    expect(result.targets[0]?.applicable[0]?.observation.raw_bytes)
      .toEqual(encoder.encode("Workers must never edit .aira/state.\nHandlers may access DB directly.\n"));
  });

  test("module has no native source, resolver, storage, Context, Pi, or CLI dependency", async () => {
    const directory = join(import.meta.dir, "../../src/steering-agents");
    const files = ["types.ts", "discovery.ts", "inspect.ts", "scope.ts", "index.ts"];
    const source = (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))).join("\n");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:steering-source|storage|context|\/pi\/|\/cli\/)/);
    expect(source).not.toContain("resolveSteering");
    expect(source).not.toContain("SteeringStore");
    expect(source).not.toContain("BlobStore");
    expect(source).not.toMatch(/writeFile|mkdir\(/);
  });
});
