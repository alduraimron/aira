import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile, rm, mkdir, symlink, rename, readdir, link } from "node:fs/promises";
import { join } from "node:path";
import { LegacyV1Reader } from "../../src/legacy/v1/reader";
import { legacyRunView } from "../../src/legacy/v1/view";
import { observeBytes } from "../../src/legacy/v1/identity";
import { runStateSchema } from "../../src/legacy/v1/schema";
import { at, later, fixtures, ids, project } from "./fixtures";
const frozen = new LegacyV1Reader(fixtures, { projectIdentity: "project_frozen", controlPath: "valid", runsPath: "valid" });
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup(selected?: string[]) { const x = await project(selected); clean.push(x.cleanup); return x; }

for (const id of ids) test(`frozen v1 literal ${id} survives whole-document decoding without workflows`, async () => {
  const before = await readFile(join(fixtures, "valid", id, "run.json"));
  const item = await frozen.inspect(id, at); expect(item.status).toBe("valid");
  if (item.status !== "valid") throw Error(item.detail);
  expect(item.run).toEqual(JSON.parse(before.toString())); expect(item.source.observation.run_json).toEqual(observeBytes(before));
  expect(await readFile(join(fixtures, "valid", id, "run.json"))).toEqual(before);
  const view = legacyRunView(item); expect(view.mutable).toBe(false); expect(view.resumable).toBe(false); expect(view.convertible).toBe(false);
  for (const artifact of item.source.observation.artifacts) {
    expect(artifact.observation.status).toBe("present");
    const read = await frozen.readArtifact(item, artifact.path);
    expect(read.observation.provenance).toBe("observed-now"); expect(read.observation.historical_identity).toBe("not-recorded-in-v1");
    expect(read.bytes).toEqual(new Uint8Array(await readFile(join(fixtures, "valid", id, artifact.path))));
  }
});
const invalidReader = new LegacyV1Reader(fixtures, { projectIdentity: "project_frozen", controlPath: "invalid", runsPath: "invalid" });
for (let i = 1; i <= 18; i++) {
  const id = `20260826-1100${String(i).padStart(2, "0")}-b10000${i.toString(16).padStart(2, "0")}`;
  test(`frozen negative sample ${id} retains rejection`, async () => {
    const item = await invalidReader.inspect(id, at); expect(item.status).toBe("invalid");
    if (item.status !== "invalid") throw Error("invalid fixture accepted");
    expect(item.code).toBe(i === 1 ? "LEGACY_INVALID_JSON" : i === 2 ? "LEGACY_UNSUPPORTED_VERSION" : i === 3 ? "LEGACY_ID_MISMATCH" : "LEGACY_INVALID_SCHEMA");
    expect(item.source.observation.run_json).not.toBeNull();
    if (i === 1) expect(item.source.observation.original_run_id).toBeNull();
    if (i === 3) expect(item.source.observation.original_run_id).not.toBe(item.source.observation.locator.run_directory_id);
  });
}
test("historical statuses, generic approval, pending feedback and flat loop remain distinct", async () => {
  const approved = await frozen.inspect(ids[5]!, at), pending = await frozen.inspect(ids[6]!, at), loop = await frozen.inspect(ids[8]!, at);
  if (approved.status !== "valid" || pending.status !== "valid" || loop.status !== "valid") throw Error("fixtures");
  expect(Object.values(approved.run.steps).some((s) => s.result === "approved")).toBe(true);
  expect(legacyRunView(approved).warnings.some((w) => w.code === "LEGACY_APPROVAL_UNATTRIBUTABLE")).toBe(true);
  expect(pending.run.revisions?.at(-1)?.status).toBe("pending"); expect(loop.run.status).toBe("waiting");
  expect(Object.values(loop.run.steps).every((s) => !("steps" in s))).toBe(true);
});
test("invalid or missing config/workflows/commands do not affect frozen decoding", async () => {
  const x = await setup(); await writeFile(join(x.root, ".aira", "config.yaml"), "invalid: [");
  await writeFile(join(x.root, ".aira", "workflows"), "not even a directory");
  expect((await x.reader.inspect(ids[5]!, at)).status).toBe("valid");
});
test("source identity is relocatable and excludes inspection timestamps", async () => {
  const x = await setup(), y = await setup(); const a = await x.reader.inspect(ids[5]!, at), b = await y.reader.inspect(ids[5]!, later);
  expect(a.source).toEqual(b.source); expect(a.inspected_at).not.toBe(b.inspected_at);
  expect(JSON.stringify(a.source)).not.toContain(x.root); expect(Object.isFrozen(a.source.observation.artifacts)).toBe(true);
  const other = new LegacyV1Reader(x.root, { projectIdentity: "project_other" });
  expect((await other.inspect(ids[5]!, at)).source.id).not.toBe(a.source.id);
});
test("missing surviving bytes remain unknown without a fabricated digest", async () => {
  const x = await setup(); await rm(join(x.root, ".aira/runs", ids[5]!, "artifacts/plan-v1.md"));
  const item = await x.reader.inspect(ids[5]!, at); expect(item.status).toBe("valid");
  const missing = item.source.observation.artifacts.find((a) => a.path.endsWith("v1.md"))!;
  expect(missing.observation.status).toBe("missing"); expect("bytes" in missing.observation).toBe(false); expect(missing.historical_bytes).toBe("unknown");
});
for (const path of ["../secret", "/etc/passwd", "C:\\secret", "artifacts/../../secret", "artifacts/%2e%2e/secret", "artifacts/%zz", "artifacts/a\\b", "sessions/output.jsonl"]) {
  test(`unsafe historical step artifact is retained but never followed: ${path}`, async () => {
    const x = await setup(), file = join(x.root, ".aira/runs", ids[5]!, "run.json");
    const json = JSON.parse(await readFile(file, "utf8")); json.steps.unsafe = { status: "completed", attempt: 1, artifact: path };
    expect(runStateSchema.safeParse(json).success).toBe(true); await writeFile(file, JSON.stringify(json));
    const item = await x.reader.inspect(ids[5]!, at); expect(item.status).toBe("valid");
    expect(item.source.observation.artifacts.find((a) => a.path === path)?.observation.status).toBe("unsafe");
    await expect(x.reader.readArtifact(item, path)).rejects.toMatchObject({ code: "LEGACY_PATH_UNSAFE" });
  });
}
for (const kind of ["artifact", "artifact-directory", "run", "run-json", "runs", "control", "hardlink"]) test(`reject ${kind} substitution without reading target`, async () => {
  const x = await setup();
  const run = join(x.root, ".aira/runs", ids[5]!);
  const path = kind === "artifact" || kind === "hardlink" ? join(run, "artifacts/plan-v1.md") : kind === "artifact-directory" ? join(run, "artifacts") :
    kind === "run-json" ? join(run, "run.json") : kind === "run" ? run : kind === "runs" ? join(x.root, ".aira/runs") : join(x.root, ".aira");
  await rename(path, `${path}.old`);
  if (kind === "hardlink") await link(`${path}.old`, path); else await symlink(`${path}.old`, path);
  const item = await x.reader.inspect(ids[5]!, at);
  if (["artifact", "artifact-directory", "hardlink"].includes(kind)) {
    expect(item.status).toBe("valid"); expect(item.source.observation.artifacts.some((a) => a.observation.status === "unsafe")).toBe(true);
  } else { expect(item.status).toBe("invalid"); if (item.status === "invalid") expect(item.code).toBe("LEGACY_PATH_UNSAFE"); }
});
test("readers never initialize or lock storage", async () => {
  const x = await setup(); const before = await readdir(join(x.root, ".aira"));
  const file = join(x.root, ".aira/runs", ids[5]!, "run.json"), bytes = await readFile(file);
  await x.reader.discover(); await x.reader.inspect(ids[5]!, at); await x.inspect();
  expect(await readdir(join(x.root, ".aira"))).toEqual(before); expect(await readFile(file)).toEqual(bytes);
});
test("discovery reports unknown entries and invalid run directories honestly", async () => {
  const x = await setup(); await writeFile(join(x.root, ".aira/runs", ids[0]!), "not a directory");
  await mkdir(join(x.root, ".aira/runs", "unrecognized"));
  const found = await x.reader.discover(); expect(found.ids).toContain(ids[0]!); expect(found.warnings.length).toBe(1);
  expect((await x.reader.inspect(ids[0]!, at)).status).toBe("invalid");
});
test.each(["../escape", "/absolute", "run_v2", "%2f"])("unsafe run identity %s rejected before I/O", async (id) => {
  await expect(frozen.inspect(id, at)).rejects.toMatchObject({ code: "LEGACY_PATH_UNSAFE" });
});
