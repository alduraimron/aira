import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planSteeringMaterialization } from "../../src/steering-materialization";
import { inspectNativeSteering } from "../../src/steering-source";
import { materializationContext } from "./fixtures";

const worker = fileURLToPath(new URL("./process-worker.ts", import.meta.url));
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

for (const boundary of [
  "after-temp-write",
  "after-temp-fsync",
  "before-target-publication",
  "after-target-publication",
  "before-directory-fsync",
] as const) {
  test(`SIGKILL at ${boundary} leaves an absent or complete native target`, async () => {
    const value = await materializationContext(); clean.push(value.cleanup);
    const planned = await planSteeringMaterialization({
      project_root: value.root, project: "acme", store: value.store, blobs: value.store.blobs,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const request = join(value.root, `materialization-crash-${randomUUID()}.json`);
    await writeFile(request, JSON.stringify(planned.plan));
    const child = Bun.spawn([Bun.which("bun")!, worker, value.root, request, boundary], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toBe("");

    const inspection = await inspectNativeSteering(value.root, { project: "acme" });
    const published = boundary === "after-target-publication" || boundary === "before-directory-fsync";
    expect(inspection.status).toBe("valid");
    expect(inspection.proposals).toHaveLength(published ? 1 : 0);
    if (published) {
      const target = join(value.root, ".aira", "steering", "architecture.md");
      const bytes = await Bun.file(target).bytes();
      expect(bytes.length).toBeGreaterThan(0);
      expect(inspection.proposals[0]!.body_bytes.length).toBeGreaterThan(0);
    } else {
      await expect(lstat(join(value.root, ".aira", "steering", "architecture.md"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const after = await value.store.loadRegistry("acme");
    expect(String(after.registry.generation)).toBe("0");
  }, 30_000);
}
