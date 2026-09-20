import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSteeringSnapshot, resolveSteering } from "../../src/steering";
import { FileSteeringSnapshotStore } from "../../src/storage/file/steering-snapshot-store";
import { snapshotMetadata, temporary as steeringTemporary } from "../steering-store/fixtures";
import { putAgents } from "../steering-agents/fixtures";
import { applyCurrentAgentsImport, currentAgentsImportPlan } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function context() {
  const value = await steeringTemporary();
  clean.push(value.cleanup);
  return value;
}

function currentResolution(snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof context>>["store"]["loadRegistry"]>>) {
  const catalog = snapshot.registry.resources.filter((resource) => resource.status === "active").map((resource) => {
    if (resource.status !== "active" || resource.current === null) throw new Error("active reference missing");
    const current = resource.current;
    const revision = snapshot.revisions.find((candidate) => candidate.identity.id === resource.id &&
      candidate.identity.revision === current.revision && candidate.identity.hash === current.hash);
    if (revision === undefined) throw new Error(`missing ${resource.id}`);
    return revision;
  });
  return resolveSteering({
    schema: "aira.dev/steering-resolution/v1",
    policy: "aira.dev/steering-policy/conservative/v1",
    project: "acme",
    action: { phase: "implementation", paths: { status: "known", paths: ["packages/api/src/user.ts"] } },
    catalog,
    selections: catalog.map((resource) => ({ resource: resource.identity, inclusion: resource.inclusion })),
    manual: [],
    supported_contracts: [],
    available_enforcement: [],
  });
}

function snapshotFor(snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof context>>["store"]["loadRegistry"]>>) {
  const resolution = currentResolution(snapshot);
  expect(resolution.status).toBe("resolved");
  if (resolution.status !== "resolved") throw new Error(JSON.stringify(resolution.diagnostics));
  const built = buildSteeringSnapshot(resolution, { constructed_at: "2026-08-26T12:00:00.000Z" });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  return built.value;
}

describe("imported AGENTS SteeringSnapshot provenance", () => {
  test("pins exact imported revisions and remains historical after a newer import and source removal", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "guidance A\r\n");
    const initialPlan = await currentAgentsImportPlan(value);
    expect(initialPlan.ok).toBe(true);
    if (!initialPlan.ok) return;
    const first = await applyCurrentAgentsImport(value, initialPlan.plan, "operation_agents_import_snapshot_a");
    expect(first.ok).toBe(true);
    const authorityA = await value.store.loadRegistry("acme");
    const snapshotA = snapshotFor(authorityA);
    const snapshots = new FileSteeringSnapshotStore(value.root);
    await snapshots.putSnapshot(snapshotA, snapshotMetadata(authorityA, snapshotA, "operation_agents_snapshot_a"));

    const entryA = snapshotA.semantic.resources[0]!;
    expect(entryA.revision.layer).toBe("interoperability");
    expect(entryA.revision.rules).toEqual([]);
    expect(entryA.scope).toEqual({ kind: "project-global" });
    expect(entryA.reasons.map((reason) => reason.kind)).toEqual(["selection"]);
    expect(entryA.revision.provenance).toEqual(expect.objectContaining({
      kind: "interoperability",
      source: expect.objectContaining({
        kind: "agents-md",
        agents_observation: expect.objectContaining({ source_path: "AGENTS.md", scope: { root: ".", depth: 0 } }),
        import_policy: expect.objectContaining({ contract: "aira.dev/steering-agents-import-policy/v1" }),
      }),
    }));

    await writeFile(join(value.root, "AGENTS.md"), "guidance B\r\n");
    const updatePlan = await currentAgentsImportPlan(value);
    expect(updatePlan.ok).toBe(true);
    if (!updatePlan.ok) return;
    expect(updatePlan.plan.actions[0]?.kind).toBe("update");
    const second = await applyCurrentAgentsImport(value, updatePlan.plan, "operation_agents_import_snapshot_b");
    expect(second.ok).toBe(true);
    const authorityB = await value.store.loadRegistry("acme");
    const snapshotB = snapshotFor(authorityB);
    await snapshots.putSnapshot(snapshotB, snapshotMetadata(authorityB, snapshotB, "operation_agents_snapshot_b"));

    expect(snapshotA.id).not.toBe(snapshotB.id);
    expect(String(snapshotA.semantic.resources[0]!.revision.identity.revision)).toBe("1");
    expect(String(snapshotB.semantic.resources[0]!.revision.identity.revision)).toBe("2");
    expect(snapshotA.semantic.resources[0]!.revision.content.hash).not.toBe(snapshotB.semantic.resources[0]!.revision.content.hash);
    expect(authorityB.registry.resources[0]!.current).toEqual(snapshotB.semantic.resources[0]!.revision.identity);

    await rm(join(value.root, "AGENTS.md"));
    const loadedA = await snapshots.getSnapshot(snapshotA.id);
    const loadedB = await snapshots.getSnapshot(snapshotB.id);
    expect(loadedA.semantic.resources[0]!.revision.identity).toEqual(snapshotA.semantic.resources[0]!.revision.identity);
    expect(loadedB.semantic.resources[0]!.revision.identity).toEqual(snapshotB.semantic.resources[0]!.revision.identity);
    expect(await snapshots.verifySnapshot(snapshotA.id)).toEqual(expect.objectContaining({ source_head: authorityA.head }));
    expect(await snapshots.verifySnapshot(snapshotB.id)).toEqual(expect.objectContaining({ source_head: authorityB.head }));
  });
});
