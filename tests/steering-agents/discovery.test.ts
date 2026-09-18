import { afterEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBytes } from "../../src/canonical-json";
import {
  agentsInteropDiscoveryPolicy,
  compareAgentsObservation,
  inspectAgentsInterop,
  observeAgentsSource,
} from "../../src/steering-agents";
import { codeList, encoder, putAgents, temporaryAgentsProject } from "./fixtures";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0)) await remove(); });

async function project() {
  const value = await temporaryAgentsProject();
  cleanup.push(value.cleanup);
  return value;
}

function observation(inspection: Awaited<ReturnType<typeof inspectAgentsInterop>>, sourcePath: string) {
  const value = inspection.observations.find((candidate) => candidate.source_path === sourcePath);
  if (value === undefined) throw new Error(`Missing ${sourcePath}`);
  return value;
}

describe("AGENTS interoperability discovery", () => {
  test("discovers root and nested files in deterministic source-path order", async () => {
    const context = await project();
    await putAgents(context.root, "packages/web/AGENTS.md", "web\n");
    await putAgents(context.root, "AGENTS.md", "root\n");
    await putAgents(context.root, "packages/api/AGENTS.md", "api\n");

    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    expect(inspection.complete).toBe(true);
    expect(inspection.root_status).toBe("present");
    expect(inspection.observations.map((value) => value.source_path)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "packages/web/AGENTS.md",
    ]);
    expect(inspection.observations.map((value) => value.scope.root)).toEqual([".", "packages/api", "packages/web"]);
    expect(inspection.observations.map((value) => value.provenance)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interoperability", source_type: "AGENTS.md" }),
    ]));
  });

  test("permits nested guidance without a root file and permits no AGENTS files", async () => {
    const nested = await project();
    await putAgents(nested.root, "packages/api/AGENTS.md", "api only\n");
    const nestedInspection = await inspectAgentsInterop(nested.root, { project: "acme" });
    expect(nestedInspection.status).toBe("valid");
    expect(nestedInspection.root_status).toBe("missing");
    expect(nestedInspection.observations.map((value) => value.source_path)).toEqual(["packages/api/AGENTS.md"]);
    expect(codeList(nestedInspection)).toContain("agents-root-missing");

    const empty = await project();
    const emptyInspection = await inspectAgentsInterop(empty.root, { project: "acme" });
    expect(emptyInspection.status).toBe("valid");
    expect(emptyInspection.complete).toBe(true);
    expect(emptyInspection.root_status).toBe("missing");
    expect(emptyInspection.observations).toEqual([]);
  });

  test("uses exact case-sensitive AGENTS.md recognition", async () => {
    const context = await project();
    await putAgents(context.root, "agents.md", "ignored\n");
    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    expect(inspection.observations).toEqual([]);
    expect(inspection.root_status).toBe("missing");
  });

  test("normalizes equivalent directory enumeration independently of creation order", async () => {
    const first = await project(), second = await project();
    const files = [
      ["AGENTS.md", "root\n"],
      ["packages/api/AGENTS.md", "api\n"],
      ["packages/web/AGENTS.md", "web\n"],
    ] as const;
    for (const [path, body] of files) await putAgents(first.root, path, body);
    for (const [path, body] of [...files].reverse()) await putAgents(second.root, path, body);
    const normalize = (inspection: Awaited<ReturnType<typeof inspectAgentsInterop>>) => ({
      status: inspection.status,
      complete: inspection.complete,
      root_status: inspection.root_status,
      observations: inspection.observations.map((value) => ({
        path: value.source_path,
        scope: value.scope,
        source_identity: value.source_identity,
        observation_identity: value.observation_identity,
        source: value.source,
        provenance: value.provenance,
      })),
      diagnostics: inspection.diagnostics.map((value) => ({ code: value.code, severity: value.severity, path: value.path, detail: value.detail })),
    });
    expect(normalize(await inspectAgentsInterop(first.root, { project: "acme" })))
      .toEqual(normalize(await inspectAgentsInterop(second.root, { project: "acme" })));
  });

  test("excludes internal and dependency trees without reading their AGENTS.md files", async () => {
    const context = await project();
    await putAgents(context.root, "src/AGENTS.md", "src\n");
    for (const path of [
      ".git/AGENTS.md",
      ".aira/state/AGENTS.md",
      ".aira/steering/AGENTS.md",
      "node_modules/pkg/AGENTS.md",
      "vendor/lib/AGENTS.md",
    ]) await putAgents(context.root, path, Uint8Array.from([0xff, 0x00]));

    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    expect(inspection.observations.map((value) => value.source_path)).toEqual(["src/AGENTS.md"]);
    expect(inspection.skipped_subtrees.map((value) => value.path)).toEqual([".aira", ".git", "node_modules", "vendor"]);
  });
});

describe("exact AGENTS byte observations", () => {
  test("preserves LF, CRLF, trailing newline, absent newline, and whitespace exactly", async () => {
    const context = await project();
    const bodies = {
      "AGENTS.md": "root\n",
      "lf/AGENTS.md": "line\nsecond\n",
      "crlf/AGENTS.md": "line\r\nsecond\r\n",
      "none/AGENTS.md": "no trailing newline",
      "space/AGENTS.md": "line \n",
    } as const;
    for (const [path, body] of Object.entries(bodies)) await putAgents(context.root, path, body);

    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    for (const [path, body] of Object.entries(bodies)) {
      const value = observation(inspection, path);
      const expected = encoder.encode(body);
      expect(value.raw_bytes).toEqual(expected);
      expect(value.source.bytes).toBe(expected.length);
      expect(value.source.hash).toBe(hashBytes(expected));
      expect(value.content_encoding).toBe("aira.dev/steering-bytes/raw/v1");
      expect(value.text_encoding).toBe("utf-8");
    }
    const hashes = ["lf/AGENTS.md", "crlf/AGENTS.md", "none/AGENTS.md", "space/AGENTS.md"]
      .map((path) => observation(inspection, path).source.hash);
    expect(new Set(hashes).size).toBe(4);
  });

  test("retains frontmatter-looking content and a UTF-8 BOM as ordinary opaque bytes", async () => {
    const context = await project();
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode("---\naira:\n  authority: enforceable\n---\nWorkers must comply.\n")]);
    await putAgents(context.root, "AGENTS.md", bytes);
    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    const source = observation(inspection, "AGENTS.md");
    expect(inspection.status).toBe("valid");
    expect(source.raw_bytes).toEqual(bytes);
    expect("authority" in source).toBe(false);
    expect("rules" in source).toBe(false);
  });

  test("hashes bytes before strict UTF-8 validation and rejects invalid UTF-8 and NUL", async () => {
    const context = await project();
    const invalid = Uint8Array.from([0xc3, 0x28]);
    const nul = Uint8Array.from([0x61, 0x00, 0x62]);
    await putAgents(context.root, "invalid/AGENTS.md", invalid);
    await putAgents(context.root, "nul/AGENTS.md", nul);

    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("invalid");
    expect(codeList(inspection)).toEqual(expect.arrayContaining(["agents-invalid-utf8", "agents-nul-content"]));
    const rejectedInvalid = inspection.rejected_sources.find((value) => value.source_path === "invalid/AGENTS.md");
    const rejectedNul = inspection.rejected_sources.find((value) => value.source_path === "nul/AGENTS.md");
    expect(rejectedInvalid?.file?.source.hash).toBe(hashBytes(invalid));
    expect(rejectedNul?.file?.source.hash).toBe(hashBytes(nul));
  });
});

describe("bounded and safe AGENTS discovery", () => {
  test("rejects symlinked AGENTS files and directories without following external targets", async () => {
    const context = await project();
    const outsideFile = join(context.root, "outside.md");
    const outsideDirectory = join(context.root, "outside-directory");
    await writeFile(outsideFile, "outside\n");
    await mkdir(outsideDirectory);
    await symlink(outsideFile, join(context.root, "AGENTS.md"));
    await mkdir(join(context.root, "packages"));
    await symlink(outsideDirectory, join(context.root, "packages", "external"), "dir");

    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("invalid");
    expect(inspection.root_status).toBe("unsafe");
    expect(codeList(inspection).filter((code) => code === "agents-source-unsafe").length).toBeGreaterThanOrEqual(2);
    expect(inspection.observations).toEqual([]);
  });

  test("rejects a non-regular AGENTS.md and unsafe direct source paths", async () => {
    const context = await project();
    const fifo = join(context.root, "AGENTS.md");
    const created = Bun.spawnSync(["mkfifo", fifo]);
    expect(created.exitCode).toBe(0);
    const original = join(context.root, "original.md");
    await writeFile(original, "hardlink source\n");
    await mkdir(join(context.root, "linked"));
    await link(original, join(context.root, "linked", "AGENTS.md"));
    await mkdir(join(context.root, "directory", "AGENTS.md"), { recursive: true });
    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    expect(inspection.status).toBe("invalid");
    expect(codeList(inspection)).toContain("agents-source-unsafe");
    expect(inspection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "linked/AGENTS.md", detail: "hardlink" }),
      expect.objectContaining({ path: "directory/AGENTS.md", detail: "non-regular" }),
    ]));

    for (const path of ["../AGENTS.md", "/tmp/AGENTS.md", "packages/../AGENTS.md", "packages\\AGENTS.md"] as const) {
      const result = observeAgentsSource({ project: "acme", source_path: path, bytes: encoder.encode("body") });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((value) => value.code)).toContain("agents-path-invalid");
    }
  });

  test("enforces file, aggregate, file-count, and depth limits", async () => {
    const large = await project();
    await putAgents(large.root, "AGENTS.md", new Uint8Array(agentsInteropDiscoveryPolicy.max_file_bytes + 1).fill(0x61));
    const largeInspection = await inspectAgentsInterop(large.root, { project: "acme" });
    expect(codeList(largeInspection)).toContain("agents-file-too-large");

    const aggregate = await project();
    for (let index = 0; index <= Math.floor(agentsInteropDiscoveryPolicy.max_aggregate_bytes / agentsInteropDiscoveryPolicy.max_file_bytes); index++)
      await putAgents(aggregate.root, `aggregate-${index}/AGENTS.md`, new Uint8Array(agentsInteropDiscoveryPolicy.max_file_bytes).fill(0x61));
    const aggregateInspection = await inspectAgentsInterop(aggregate.root, { project: "acme" });
    expect(aggregateInspection.complete).toBe(false);
    expect(codeList(aggregateInspection)).toEqual(expect.arrayContaining(["agents-aggregate-too-large", "agents-discovery-incomplete"]));

    const count = await project();
    for (let index = 0; index <= agentsInteropDiscoveryPolicy.max_files; index++)
      await putAgents(count.root, `count-${index.toString().padStart(3, "0")}/AGENTS.md`, "x");
    const countInspection = await inspectAgentsInterop(count.root, { project: "acme" });
    expect(countInspection.complete).toBe(false);
    expect(codeList(countInspection)).toContain("agents-file-limit");

    const deep = await project();
    const parts = Array.from({ length: agentsInteropDiscoveryPolicy.max_traversal_depth + 1 }, (_, index) => `d${index}`);
    await putAgents(deep.root, `${parts.join("/")}/AGENTS.md`, "deep\n");
    const deepInspection = await inspectAgentsInterop(deep.root, { project: "acme" });
    expect(deepInspection.complete).toBe(false);
    expect(codeList(deepInspection)).toContain("agents-depth-limit");
  });

  test("detects a same-byte filesystem replacement and a move during later freshness comparison", async () => {
    const context = await project();
    const source = await putAgents(context.root, "AGENTS.md", "exact\n");
    const reviewed = observation(await inspectAgentsInterop(context.root, { project: "acme" }), "AGENTS.md");
    const replacement = join(context.root, "replacement.tmp");
    await writeFile(replacement, await readFile(source));
    await rename(replacement, source);
    const replaced = observation(await inspectAgentsInterop(context.root, { project: "acme" }), "AGENTS.md");
    expect(compareAgentsObservation(reviewed, replaced)).toEqual({ status: "stale", reasons: ["source-replaced"] });

    await mkdir(join(context.root, "packages", "api"), { recursive: true });
    await rename(source, join(context.root, "packages", "api", "AGENTS.md"));
    const moved = observation(await inspectAgentsInterop(context.root, { project: "acme" }), "packages/api/AGENTS.md");
    expect(compareAgentsObservation(replaced, moved)).toEqual(expect.objectContaining({
      status: "stale",
      reasons: expect.arrayContaining(["source-path-changed", "scope-root-changed", "source-identity-changed"]),
    }));
  });

  test("requires an explicit absolute canonical project root and never creates control state", async () => {
    const invalid = await inspectAgentsInterop("relative/project", { project: "acme" });
    expect(invalid.status).toBe("invalid");
    expect(codeList(invalid)).toContain("agents-root-unsafe");

    const context = await project();
    const file = await putAgents(context.root, "AGENTS.md", "owned bytes\n");
    const before = await lstat(file, { bigint: true });
    const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
    const after = await lstat(file, { bigint: true });
    expect(inspection.status).toBe("valid");
    expect(before.ino).toBe(after.ino);
    await expect(lstat(join(context.root, ".aira", "state"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(file);
  });
});
