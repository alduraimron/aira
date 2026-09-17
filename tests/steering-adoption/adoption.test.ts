import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applySteeringAdoption,
  inspectAndPlanSteeringAdoption,
  planSteeringAdoption,
} from "../../src/steering-adoption";
import { inspectNativeSteering } from "../../src/steering-source";
import { publish, retire, revision, temporary as steeringTemporary } from "../steering-store/fixtures";
import { putSource, sourceBytes, sourceMetadata, temporaryProject } from "../steering-native-source/fixtures";
import { adoptionContext, applyCurrent, authorization, planCurrent } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function context() {
  const value = await adoptionContext();
  clean.push(value.cleanup);
  return value;
}

function sourceIssueCodes(result: Awaited<ReturnType<typeof applySteeringAdoption>>): string[] {
  return result.ok ? result.result.issues.map((issue) => issue.code) : result.issues.map((issue) => issue.code);
}

async function initialPlan(value: Awaited<ReturnType<typeof context>>, selection?: readonly string[]) {
  const plan = await planCurrent(value, selection);
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(JSON.stringify(plan.issues));
  return plan.plan;
}

async function adoptArchitecture(value: Awaited<ReturnType<typeof context>>, operation = "operation_adopt_architecture") {
  await putSource(value.steering, "architecture.md");
  const plan = await initialPlan(value);
  const result = await applyCurrent(value, plan, operation);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { plan, result: result.result };
}

describe("Steering adoption planning", () => {
  test("an empty inspection creates an immutable empty no-op plan without state mutation", async () => {
    const project = await temporaryProject();
    clean.push(project.cleanup);
    const inspection = await inspectNativeSteering(project.root, { project: "acme" });
    const plan = planSteeringAdoption({ inspection, registry: null });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.actions).toEqual([]);
    expect(plan.plan.selection.action_ids).toEqual([]);
    expect(Object.isFrozen(plan.plan)).toBe(true);
    await expect(lstat(join(project.root, ".aira", "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("inspect-and-plan remains read-only when authoritative state is absent", async () => {
    const value = await steeringTemporary();
    clean.push(value.cleanup);
    const steering = join(value.root, ".aira", "steering");
    await mkdir(steering, { recursive: true });
    await putSource(steering, "architecture.md");
    const plan = await inspectAndPlanSteeringAdoption({ project_root: value.root, project: "acme", store: value.store });
    expect(plan.ok).toBe(true);
    await expect(lstat(join(value.root, ".aira", "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("creates the authoritative registry from an absent-registry plan", async () => {
    const value = await steeringTemporary();
    clean.push(value.cleanup);
    const steering = join(value.root, ".aira", "steering");
    await mkdir(steering, { recursive: true });
    await putSource(steering, "architecture.md");
    const inspection = await inspectNativeSteering(value.root, { project: "acme" });
    const planned = planSteeringAdoption({ inspection, registry: null });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const result = await applySteeringAdoption({
      project_root: value.root,
      store: value.store,
      plan: planned.plan,
      operation: "operation_adopt_registry_genesis",
      authorization: authorization(planned.plan),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.result.current.head?.sequence)).toBe("1");
    expect(String(result.result.current.steering_generation)).toBe("0");
  });

  test("plans deterministic create actions with exact reviewed source and absent-resource CAS", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    const first = await initialPlan(value);
    const second = await initialPlan(value);
    expect(first.id).toBe(second.id);
    expect(first.hash).toBe(second.hash);
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]).toEqual(expect.objectContaining({ kind: "create", resource: "steering.architecture",
      expectation: { id: "steering.architecture", status: "absent" },
      next: expect.objectContaining({ revision: "1" }),
    }));
    expect(first.actions[0]!.source.authoritative_provenance).toEqual(expect.objectContaining({
      kind: "project",
      native_source: expect.objectContaining({ source_path: ".aira/steering/architecture.md" }),
    }));
  });

  test("plans updates and unchanged actions without manufacturing a revision", async () => {
    const value = await context();
    await adoptArchitecture(value);
    const unchanged = await initialPlan(value);
    expect(unchanged.actions[0]).toEqual(expect.objectContaining({ kind: "unchanged" }));
    const path = join(value.steering, "architecture.md");
    await writeFile(path, await readFile(path));
    const timestampOnly = await initialPlan(value);
    expect(timestampOnly.id).toBe(unchanged.id);
    expect(timestampOnly.actions[0]).toEqual(expect.objectContaining({ kind: "unchanged" }));
    const beforeNoOp = await value.store.loadRegistry("acme");
    const noOp = await applyCurrent(value, timestampOnly, "operation_adopt_unchanged");
    expect(noOp.ok).toBe(true);
    if (noOp.ok) {
      expect(noOp.result.status).toBe("no-op");
      expect(noOp.result.committed).toBe(false);
      expect(String(noOp.result.current.steering_generation)).toBe("1");
      expect(noOp.result.current.head).toEqual(beforeNoOp.head);
    }

    await writeFile(join(value.steering, "architecture.md"), sourceBytes(sourceMetadata(), "# Changed\nexact body\n"));
    const changed = await initialPlan(value);
    expect(changed.actions[0]).toEqual(expect.objectContaining({ kind: "update", supersedes: expect.objectContaining({ revision: "1" }),
      next: expect.objectContaining({ revision: "2" }), comparison: expect.objectContaining({ body: "changed" }) }));
  });

  test("plans multiple resources as one exact atomic selection", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    await putSource(value.steering, "security.md", sourceMetadata({
      id: "steering.security" as never,
      kind: "security",
      title: "Security",
      labels: ["security"],
      rules: [],
    }), "# Security\nexact security body\n");
    const plan = await initialPlan(value);
    const subset = await initialPlan(value, ["steering.architecture"]);
    expect(plan.actions.map((action) => action.kind)).toEqual(["create", "create"]);
    expect(subset.id).not.toBe(plan.id);
    const result = await applyCurrent(value, plan, "operation_adopt_batch");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.created_revisions).toHaveLength(2);
    expect(String(result.result.current.steering_generation)).toBe("1");
    const registry = await value.store.loadRegistry("acme");
    expect(registry.registry.resources.map((resource) => String(resource.id))).toEqual(["steering.architecture", "steering.security"]);
  });

  test("duplicate native identity is excluded and missing source never implies retirement", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    await putSource(value.steering, "custom/duplicate.md");
    const duplicateInspection = await inspectNativeSteering(value.root, { project: "acme" });
    const duplicatePlan = planSteeringAdoption({ inspection: duplicateInspection, registry: value.result });
    expect(duplicatePlan.ok).toBe(false);
    if (!duplicatePlan.ok) expect(duplicatePlan.issues.map((issue) => issue.code)).toContain("adoption-source-unsafe");

    await rm(join(value.steering, "custom"), { recursive: true, force: true });
    const adopted = await adoptArchitecture(value, "operation_adopt_after_duplicate");
    await rm(join(value.steering, "architecture.md"));
    const plan = await initialPlan(value);
    expect(plan.actions).toEqual([]);
    const noOp = await applyCurrent(value, plan, "operation_source_removed_no_retire");
    expect(noOp.ok).toBe(true);
    const registry = await value.store.loadRegistry("acme");
    expect(registry.registry.resources[0]!.status).toBe("active");
    expect(registry.registry.resources[0]!.current).toEqual(adopted.result.created_revisions[0]!);
  });

  test("a retired authoritative ID is a conflict and cannot be silently reused", async () => {
    const value = await context();
    await adoptArchitecture(value, "operation_retired_source_create");
    const active = await value.store.loadRegistry("acme");
    await value.store.commit(retire(active, "steering.architecture", "operation_retire_architecture"));
    const plan = await initialPlan(value);
    expect(plan.actions[0]).toEqual(expect.objectContaining({ kind: "conflict", issues: expect.arrayContaining([
      expect.objectContaining({ code: "adoption-retired-id-reuse" }),
    ]) }));
    expect(plan.selection.action_ids).toEqual([]);
  });

  test("source, action, and registry changes alter deterministic plan identity", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    const first = await initialPlan(value);
    await writeFile(join(value.steering, "architecture.md"), sourceBytes(sourceMetadata(), "changed\n"));
    const sourceChanged = await initialPlan(value);
    expect(sourceChanged.id).not.toBe(first.id);

    await value.store.commit(publish(value.result, revision("# Security\n", "1", undefined, "steering.security"), "operation_registry_for_plan"),
      [revision("# Security\n", "1", undefined, "steering.security")]);
    const registryChanged = await initialPlan(value);
    expect(registryChanged.id).not.toBe(sourceChanged.id);
  });
});

describe("Steering adoption freshness and publication", () => {
  test("publishes exact body bytes, preserves source attribution, and advances one generation", async () => {
    const value = await context();
    const body = "# Architecture\r\n\r\n  exact body  \r\n";
    await putSource(value.steering, "architecture.md", sourceMetadata(), body);
    const plan = await initialPlan(value);
    const result = await applyCurrent(value, plan, "operation_exact_body");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reference = result.result.created_revisions[0]!;
    expect(await value.store.blobs.get(reference.hash)).toEqual(new TextEncoder().encode(body));
    const loaded = await value.store.loadRegistry("acme");
    const revision = loaded.revisions.find((entry) => entry.identity.id === "steering.architecture")!;
    expect(revision.identity).toEqual(reference);
    expect(revision.provenance).toEqual(expect.objectContaining({ native_source: expect.objectContaining({
      source_path: ".aira/steering/architecture.md",
      source: expect.objectContaining({ hash: plan.actions[0]!.source.observation.source.hash }),
      metadata_hash: plan.actions[0]!.source.observation.metadata_hash,
    }) }));
    expect(String(loaded.registry.generation)).toBe("1");
  });

  test("publishes an update with the exact predecessor and one further generation", async () => {
    const value = await context();
    await adoptArchitecture(value, "operation_update_predecessor_create");
    await writeFile(join(value.steering, "architecture.md"), sourceBytes(sourceMetadata(), "# Architecture\nupdated\n"));
    const plan = await initialPlan(value);
    const applied = await applyCurrent(value, plan, "operation_update_predecessor_publish");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const updated = applied.result.updated_revisions[0]!;
    const loaded = await value.store.loadRegistry("acme");
    const revision = loaded.revisions.find((entry) => entry.identity.revision === updated.revision)!;
    expect(revision.supersedes).toEqual(plan.actions[0]!.expectation.status === "active" ? plan.actions[0]!.expectation.current : undefined);
    expect(loaded.registry.resources[0]!.current).toEqual(updated);
    expect(String(loaded.registry.generation)).toBe("2");
  });

  test.each([
    ["body", async (root: string) => writeFile(join(root, "architecture.md"), sourceBytes(sourceMetadata(), "changed body\n"))],
    ["metadata", async (root: string) => writeFile(join(root, "architecture.md"), sourceBytes(sourceMetadata({ title: "Changed title" }), "# Architecture\n\nProject architecture guidance.\n"))],
    ["whitespace", async (root: string) => writeFile(join(root, "architecture.md"), sourceBytes(sourceMetadata(), "# Architecture\n\nProject architecture guidance. \n"))],
  ])("rejects stale %s source bytes", async (_kind, mutate) => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    const plan = await initialPlan(value);
    await mutate(value.steering);
    const result = await applyCurrent(value, plan, `operation_stale_${_kind}`);
    expect(result.ok).toBe(false);
    expect(sourceIssueCodes(result)).toContain("adoption-plan-source-stale");
  });

  test("rejects a source removed after planning", async () => {
    const value = await context();
    const path = await putSource(value.steering, "architecture.md");
    const plan = await initialPlan(value);
    await rm(path);
    const result = await applyCurrent(value, plan, "operation_source_missing");
    expect(result.ok).toBe(false);
    expect(sourceIssueCodes(result)).toContain("adoption-source-missing");
  });

  test("rejects same-byte source replacement and source movement as stale", async () => {
    const value = await context();
    const path = await putSource(value.steering, "architecture.md");
    const replacement = join(value.steering, "replacement.tmp");
    const plan = await initialPlan(value);
    await writeFile(replacement, await readFile(path));
    await rename(replacement, path);
    const replacementResult = await applyCurrent(value, plan, "operation_source_replacement");
    expect(replacementResult.ok).toBe(false);
    if (!replacementResult.ok) expect(replacementResult.issues).toContainEqual(expect.objectContaining({
      code: "adoption-plan-source-stale", reasons: ["source-replaced"],
    }));

    const movedPlan = await initialPlan(value);
    await rename(path, join(value.steering, "system-shape.md"));
    const movedResult = await applyCurrent(value, movedPlan, "operation_source_moved");
    expect(movedResult.ok).toBe(false);
    if (!movedResult.ok) expect(movedResult.issues).toContainEqual(expect.objectContaining({
      code: "adoption-plan-source-stale", reasons: ["source-path-changed"],
    }));
  });

  test("distinguishes source stale, registry stale, both stale, and both current", async () => {
    const current = await context();
    await putSource(current.steering, "architecture.md");
    const currentPlan = await initialPlan(current);
    expect((await applyCurrent(current, currentPlan, "operation_both_current")).ok).toBe(true);

    const registryOnly = await context();
    await putSource(registryOnly.steering, "architecture.md");
    const registryPlan = await initialPlan(registryOnly);
    const security = revision("# Security\n", "1", undefined, "steering.security");
    await registryOnly.store.commit(publish(registryOnly.result, security, "operation_registry_stale"), [security]);
    const registryResult = await applyCurrent(registryOnly, registryPlan, "operation_registry_stale_apply");
    expect(registryResult.ok).toBe(false);
    expect(sourceIssueCodes(registryResult)).toContain("adoption-plan-registry-stale");

    const both = await context();
    await putSource(both.steering, "architecture.md");
    const bothPlan = await initialPlan(both);
    await writeFile(join(both.steering, "architecture.md"), sourceBytes(sourceMetadata(), "changed\n"));
    const other = revision("# Security\n", "1", undefined, "steering.security");
    await both.store.commit(publish(both.result, other, "operation_both_registry_stale"), [other]);
    const bothResult = await applyCurrent(both, bothPlan, "operation_both_stale_apply");
    expect(bothResult.ok).toBe(false);
    expect(sourceIssueCodes(bothResult)).toEqual(expect.arrayContaining([
      "adoption-plan-source-stale", "adoption-plan-registry-stale",
    ]));
  });
});

describe("authorization, idempotency, and batch closure", () => {
  test("requires an explicit local human and rejects worker/model authorization", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    const plan = await initialPlan(value);
    const missing = await applySteeringAdoption({ project_root: value.root, store: value.store, plan,
      operation: "operation_missing_authorization" });
    expect(sourceIssueCodes(missing)).toContain("adoption-authorization-required");

    const worker = await applySteeringAdoption({ project_root: value.root, store: value.store, plan,
      operation: "operation_worker_authorization", authorization: { ...authorization(plan), by: { kind: "worker", id: "worker-1", implementation: "test" } } });
    expect(sourceIssueCodes(worker)).toContain("adoption-worker-unauthorized");
    const model = await applySteeringAdoption({ project_root: value.root, store: value.store, plan,
      operation: "operation_model_authorization", authorization: { ...authorization(plan), by: { kind: "model", id: "model-1", implementation: "test" } } });
    expect(sourceIssueCodes(model)).toContain("adoption-worker-unauthorized");
  });

  test("same plan and OperationId replay, while another plan under that ID fails storage reuse", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    const first = await initialPlan(value);
    const operation = "operation_adoption_replay";
    const committed = await applyCurrent(value, first, operation);
    expect(committed.ok).toBe(true);
    const replay = await applyCurrent(value, first, operation);
    expect(replay.ok).toBe(true);
    if (committed.ok && replay.ok) {
      expect(replay.result.replayed).toBe(true);
      expect(replay.result.authoritative_commit).toBe(committed.result.authoritative_commit);
    }

    await writeFile(join(value.steering, "architecture.md"), sourceBytes(sourceMetadata(), "changed\n"));
    const later = await initialPlan(value);
    await expect(applyCurrent(value, later, operation)).rejects.toMatchObject({ code: "STORE_OPERATION_REUSE" });
  });

  test("concurrent different plans under one OperationId reject operation reuse", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    await putSource(value.steering, "security.md", sourceMetadata({
      id: "steering.security" as never,
      kind: "security",
      title: "Security",
      labels: ["security"],
      rules: [],
    }), "# Security\n");
    const architecture = await initialPlan(value, ["steering.architecture"]);
    const security = await initialPlan(value, ["steering.security"]);
    const operation = "operation_adoption_race_reuse";
    const attempts = await Promise.allSettled([
      applyCurrent(value, architecture, operation),
      applyCurrent(value, security, operation),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled" && attempt.value.ok)).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected" && (attempt.reason as { code?: string }).code === "STORE_OPERATION_REUSE")).toBeDefined();
  });

  test("different operations racing from one expected state leave one authoritative winner", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    const plan = await initialPlan(value);
    const results = await Promise.all([
      applyCurrent(value, plan, "operation_adoption_race_a"),
      applyCurrent(value, plan, "operation_adoption_race_b"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok && sourceIssueCodes(result).includes("adoption-plan-registry-stale"))).toBeDefined();
  });

  test("an invalid selected member prevents the requested atomic publication", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md");
    await putSource(value.steering, "custom/invalid.md", sourceMetadata({
      id: "project.steering.invalid" as never,
      kind: "custom",
      custom_kind: "invalid" as never,
      layer: "project-scoped",
      scope: { kind: "path", selectors: [{ kind: "tree", path: "src" }] },
      title: "Invalid",
      labels: ["invalid"],
      rules: [],
      composition: { parents: [{ id: "steering.missing", revision: "1", hash: "sha256:9999999999999999999999999999999999999999999999999999999999999999" }], overrides: [] },
    }), "# Invalid\n");
    const planned = await planCurrent(value, ["steering.architecture", "project.steering.invalid"]);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.issues.map((issue) => issue.code)).toContain("adoption-partial-selection-invalid");
    const current = await value.store.loadRegistry("acme");
    expect(current.registry.resources).toEqual([]);
    expect(String(current.registry.generation)).toBe("0");
  });

  test("valid composition is atomic and an omitted planned dependency is rejected", async () => {
    const value = await context();
    await putSource(value.steering, "architecture.md", sourceMetadata(), "# Architecture\nparent\n");
    const beforeChild = await inspectNativeSteering(value.root, { project: "acme" });
    const parent = beforeChild.proposals[0]!.observation.body;
    await putSource(value.steering, "custom/api.md", sourceMetadata({
      id: "project.steering.api" as never,
      kind: "custom",
      custom_kind: "api" as never,
      layer: "project-scoped",
      scope: { kind: "path", selectors: [{ kind: "tree", path: "src" }] },
      title: "API",
      labels: ["api"],
      rules: [],
      composition: { parents: [{ id: "steering.architecture", revision: "1", hash: parent.hash }], overrides: [] },
    }), "# API\nchild\n");
    const partial = await planCurrent(value, ["project.steering.api"]);
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.issues.map((issue) => issue.code)).toContain("adoption-partial-selection-invalid");

    const plan = await initialPlan(value);
    const result = await applyCurrent(value, plan, "operation_composed_batch");
    expect(result.ok).toBe(true);
    const registry = await value.store.loadRegistry("acme");
    expect(registry.registry.resources).toHaveLength(2);
    expect(String(registry.registry.generation)).toBe("1");
  });
});

describe("application boundaries", () => {
  test("adoption modules do not resolve Context, write materialized files, parse AGENTS, or depend on Pi/CLI", async () => {
    const root = join(import.meta.dir, "../../src/steering-adoption");
    const source = (await Promise.all(["types.ts", "plan.ts", "apply.ts", "index.ts"].map((name) => readFile(join(root, name), "utf8")))).join("\n");
    expect(source).not.toContain("resolveSteering");
    expect(source).not.toContain("AGENTS.md");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:\/pi\/|\/cli\/|context\/resolver)/);
    // Adoption may recognize the pure canonical renderer so a freshly
    // materialized projection does not manufacture a source-lineage revision.
    // It must not own authoring filesystem publication.
    expect(source).not.toMatch(/steering-materialization\/(?:apply|plan|fs)/);
    expect(source).not.toContain("publishMaterializationTarget");
    expect(source).not.toContain("ensureMaterializationDirectories");
  });
});
