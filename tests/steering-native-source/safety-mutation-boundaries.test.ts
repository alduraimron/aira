import { afterEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  compareSteeringSourceObservations,
  inspectNativeSteering,
  parseNativeSteeringSource,
  steeringSourceObservationMatches,
  type SteeringSourceObservation,
} from "../../src/steering-source";
import { putSource, sourceBytes, sourceMetadata, temporaryProject } from "./fixtures";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0)) await remove(); });

async function project() {
  const value = await temporaryProject();
  cleanup.push(value.cleanup);
  return value;
}

const codes = (inspection: Awaited<ReturnType<typeof inspectNativeSteering>>): string[] => [
  ...inspection.unsafe_paths,
  ...inspection.invalid_sources.flatMap((source) => source.issues),
].map((issue) => issue.code);

async function oneObservation(root: string): Promise<SteeringSourceObservation> {
  const inspection = await inspectNativeSteering(root, { project: "acme" });
  expect(inspection.proposals).toHaveLength(1);
  return inspection.proposals[0]!.observation;
}

describe("safe native Steering paths", () => {
  test("rejects traversal and absolute logical source declarations", () => {
    for (const path of ["../architecture.md", "/tmp/architecture.md", ".aira/steering/custom/../../architecture.md"] as const) {
      const result = parseNativeSteeringSource({ project: "acme", source_path: path, bytes: sourceBytes() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain("steering-source-path-invalid");
    }
  });

  test("requires an explicit absolute canonical trusted project root", async () => {
    const inspection = await inspectNativeSteering("relative/project", { project: "acme" });
    expect(inspection.status).toBe("invalid");
    expect(codes(inspection)).toContain("steering-source-root-unsafe");
  });

  test("rejects a symlinked Steering root", async () => {
    const context = await project();
    const target = join(context.root, "target");
    await mkdir(target);
    await rm(context.steering, { recursive: true });
    await symlink(target, context.steering, "dir");
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.root_status).toBe("unsafe");
    expect(codes(inspection)).toContain("steering-source-symlink");
  });

  test("rejects symlinked files and nested directory symlinks", async () => {
    const context = await project();
    const outside = join(context.root, "outside.md");
    await writeFile(outside, sourceBytes());
    await symlink(outside, join(context.steering, "architecture.md"));
    await mkdir(join(context.steering, "custom"));
    await symlink(context.root, join(context.steering, "custom", "external"), "dir");
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.proposals).toEqual([]);
    expect(codes(inspection).filter((code) => code === "steering-source-symlink")).toHaveLength(2);
  });

  test("rejects hardlinked and non-regular entries", async () => {
    const context = await project();
    const original = join(context.root, "original.md");
    await writeFile(original, sourceBytes());
    await link(original, join(context.steering, "architecture.md"));
    const fifo = join(context.steering, "pipe.md");
    const created = Bun.spawnSync(["mkfifo", fifo]);
    expect(created.exitCode).toBe(0);
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(codes(inspection)).toContain("steering-source-hardlink");
    expect(codes(inspection)).toContain("steering-source-non-regular");
  });

  test("physical standard/custom placement never assigns resource identity or kind", () => {
    const customAtRoot = parseNativeSteeringSource({
      project: "acme",
      source_path: ".aira/steering/api.md",
      bytes: sourceBytes(sourceMetadata({ id: "project.steering.api" as never, kind: "custom", custom_kind: "api" as never, rules: [], title: "API", labels: [] })),
    });
    expect(customAtRoot.ok).toBe(true);
    if (customAtRoot.ok) expect(String(customAtRoot.observation.identity.id)).toBe("project.steering.api");

    const standardInCustom = parseNativeSteeringSource({
      project: "acme",
      source_path: ".aira/steering/custom/architecture.md",
      bytes: sourceBytes(),
    });
    expect(standardInCustom.ok).toBe(true);
    if (standardInCustom.ok) expect(standardInCustom.observation.identity.kind).toBe("architecture");
  });

  test("returns only project-relative logical source paths", async () => {
    const context = await project();
    await putSource(context.steering, "architecture.md");
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    const path = inspection.discovered_sources[0]!.source_path;
    expect(path).toBe(".aira/steering/architecture.md");
    expect(path).not.toContain(context.root);
    expect(relative(context.root, context.steering)).toBe(".aira/steering");
  });
});

describe("exact source mutation comparison", () => {
  test("an unchanged reinspection matches even when timestamps are not identity", async () => {
    const context = await project();
    const path = await putSource(context.steering, "architecture.md");
    const reviewed = await oneObservation(context.root);
    const bytes = await readFile(path);
    await writeFile(path, bytes);
    const current = await oneObservation(context.root);
    expect(reviewed.source.hash).toBe(current.source.hash);
    expect(compareSteeringSourceObservations(reviewed, current)).toEqual({ status: "match", reasons: [] });
    expect(steeringSourceObservationMatches(reviewed, current)).toBe(true);
  });

  test("body, metadata, and whitespace mutations are stale", async () => {
    const context = await project();
    const path = await putSource(context.steering, "architecture.md", sourceMetadata(), "body\n");
    const reviewed = await oneObservation(context.root);

    await writeFile(path, sourceBytes(sourceMetadata(), "changed body\n"));
    const body = await oneObservation(context.root);
    expect(compareSteeringSourceObservations(reviewed, body).reasons).toEqual(expect.arrayContaining([
      "body-bytes-changed", "source-bytes-changed",
    ]));

    await writeFile(path, sourceBytes(sourceMetadata({ title: "Changed architecture" }), "body\n"));
    const metadata = await oneObservation(context.root);
    expect(compareSteeringSourceObservations(reviewed, metadata).reasons).toContain("metadata-changed");

    await writeFile(path, sourceBytes(sourceMetadata(), "body \n"));
    const whitespace = await oneObservation(context.root);
    expect(compareSteeringSourceObservations(reviewed, whitespace).status).toBe("stale");
    expect(compareSteeringSourceObservations(reviewed, whitespace).reasons).toContain("body-bytes-changed");
  });

  test("same-byte path replacement is stale through opened file identity", async () => {
    const context = await project();
    const path = await putSource(context.steering, "architecture.md");
    const reviewed = await oneObservation(context.root);
    const replacement = join(context.steering, "replacement.tmp");
    await writeFile(replacement, await readFile(path));
    await rename(replacement, path);
    const current = await oneObservation(context.root);
    expect(current.source.hash).toBe(reviewed.source.hash);
    expect(compareSteeringSourceObservations(reviewed, current)).toEqual({ status: "stale", reasons: ["source-replaced"] });
  });

  test("moving a source preserves logical identity but stales the reviewed physical observation", async () => {
    const context = await project();
    const from = await putSource(context.steering, "architecture.md");
    const reviewed = await oneObservation(context.root);
    await rename(from, join(context.steering, "system-shape.md"));
    const current = await oneObservation(context.root);
    expect(current.identity.id).toBe(reviewed.identity.id);
    expect(compareSteeringSourceObservations(reviewed, current).reasons).toEqual(["source-path-changed"]);
  });
});

describe("05C-4A1 read-only boundaries", () => {
  test("inspection never creates state, publishes a registry, or materializes sources", async () => {
    const context = await project();
    await putSource(context.steering, "architecture.md");
    const before = await lstat(context.steering, { bigint: true });
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    const after = await lstat(context.steering, { bigint: true });
    expect(inspection.status).toBe("valid");
    expect(before.dev).toBe(after.dev);
    expect(before.ino).toBe(after.ino);
    await expect(lstat(join(context.root, ".aira", "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("adapter modules do not import registry stores, resolver, Pi, CLI, or Context runtime", async () => {
    const directory = join(import.meta.dir, "../../src/steering-source");
    const names = ["contract.ts", "parser.ts", "mutation.ts", "inspect.ts", "index.ts"];
    const source = (await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:storage|\/pi\/|\/cli\/|context\/resolver)/);
    expect(source).not.toContain("resolveSteering");
    expect(source).not.toContain("SteeringStore");
    expect(source).not.toContain("BlobStore");
  });
});
