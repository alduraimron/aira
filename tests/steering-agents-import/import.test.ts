import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectAgentsInterop,
  observeAgentsSource,
} from "../../src/steering-agents";
import {
  agentsImportPolicy,
  applySteeringAgentsImport,
  compareAgentsImportedGuidance,
  constructSteeringAgentsImportRevision,
  mapAgentsImportObservation,
  planSteeringAgentsImport,
  steeringResourceIdForAgentsImport,
  validateAgentsImportRawResource,
} from "../../src/steering-agents-import";
import { resolveSteering, steeringResourceRevisionSchema } from "../../src/steering";
import { operationIdSchema } from "../../src/spec/domain/ids";
import { StorageError } from "../../src/storage/errors";
import { created as createdRegistry, publish, retire, revision as nativeRevision, temporary as steeringTemporary } from "../steering-store/fixtures";
import { encoder, putAgents } from "../steering-agents/fixtures";
import { agentsImportAuthorization, agentsImportAt, applyCurrentAgentsImport, currentAgentsImportPlan } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function context() {
  const value = await steeringTemporary();
  clean.push(value.cleanup);
  return value;
}

async function planned(
  value: Awaited<ReturnType<typeof context>>,
  selection?: readonly string[],
) {
  const result = await currentAgentsImportPlan(value, selection);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.plan;
}

function activeRevisions(snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof context>>["store"]["loadRegistry"]>>) {
  const revisions = [] as (typeof snapshot.revisions)[number][];
  for (const resource of snapshot.registry.resources) {
    if (resource.status !== "active" || resource.current === null) continue;
    const current = resource.current;
    const revision = snapshot.revisions.find((candidate) => candidate.identity.id === resource.id &&
      candidate.identity.revision === current.revision && candidate.identity.hash === current.hash);
    if (revision === undefined) throw new Error(`Missing ${resource.id}`);
    revisions.push(revision);
  }
  return revisions;
}

function resolveCurrent(
  snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof context>>["store"]["loadRegistry"]>>,
  paths: readonly string[],
) {
  const catalog = activeRevisions(snapshot);
  return resolveSteering({
    schema: "aira.dev/steering-resolution/v1",
    policy: "aira.dev/steering-policy/conservative/v1",
    project: "acme",
    action: { phase: "implementation", paths: { status: "known", paths } },
    catalog,
    selections: catalog.map((resource) => ({ resource: resource.identity, inclusion: resource.inclusion })),
    manual: [],
    supported_contracts: [],
    available_enforcement: [],
  });
}

describe("AGENTS import mapping and raw resource representation", () => {
  test("maps root and nested locations deterministically, independently of content", () => {
    const root = observeAgentsSource({ project: "acme", source_path: "AGENTS.md", bytes: encoder.encode("root\n") });
    const changed = observeAgentsSource({ project: "acme", source_path: "AGENTS.md", bytes: encoder.encode("root changed\n") });
    const api = observeAgentsSource({ project: "acme", source_path: "packages/api/AGENTS.md", bytes: encoder.encode("api\n") });
    const moved = observeAgentsSource({ project: "acme", source_path: "services/api/AGENTS.md", bytes: encoder.encode("api\n") });
    if (!root.ok || !changed.ok || !api.ok || !moved.ok) throw new Error("observation fixture failed");

    expect(String(mapAgentsImportObservation(root.observation).resource)).toBe("interop.steering.agents-md");
    expect(mapAgentsImportObservation(changed.observation).resource).toBe(mapAgentsImportObservation(root.observation).resource);
    expect(mapAgentsImportObservation(api.observation).resource).not.toBe(mapAgentsImportObservation(root.observation).resource);
    expect(mapAgentsImportObservation(moved.observation).resource).not.toBe(mapAgentsImportObservation(api.observation).resource);
    expect(steeringResourceIdForAgentsImport({ source_path: "packages/api/AGENTS.md" }))
      .toBe(mapAgentsImportObservation(api.observation).resource);
    expect(mapAgentsImportObservation(api.observation)).toEqual(mapAgentsImportObservation(api.observation));
    expect(agentsImportPolicy.representation.default_authority).toBe("normative");
  });

  test("rejects duplicate logical source mappings instead of choosing a collision winner", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "first\n");
    const inspection = await inspectAgentsInterop(value.root, { project: "acme" });
    const second = observeAgentsSource({ project: "acme", source_path: "AGENTS.md", bytes: encoder.encode("second\n") });
    if (!second.ok) throw new Error("second observation failed");
    const plan = planSteeringAgentsImport({
      inspection: { ...inspection, observations: [...inspection.observations, second.observation] },
      registry: null,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.issues).toContainEqual(expect.objectContaining({ code: "agents-import-resource-collision" }));
  });

  test("publishes exact AGENTS bytes as an ordinary attributed custom Steering revision", async () => {
    const value = await context();
    const body = encoder.encode("Never edit migrations.\r\nHandlers may access DB directly.\r\n");
    await putAgents(value.root, "AGENTS.md", body);
    const plan = await planned(value);
    const applied = await applyCurrentAgentsImport(value, plan, "operation_agents_import_exact");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.result.status).toBe("committed");
    const reference = applied.result.created_resources[0]!;
    expect(await value.store.blobs.get(reference.hash)).toEqual(body);

    const loaded = await value.store.loadRegistry("acme");
    const imported = loaded.revisions.find((revision) => revision.identity.id === reference.id)!;
    expect(imported).toEqual(expect.objectContaining({
      kind: "custom",
      custom_kind: "agents.interoperability",
      layer: "interoperability",
      default_authority: "normative",
      default_override_policy: "sealed",
      rules: [],
      default_enforcement: [],
      composition: { parents: [], overrides: [] },
    }));
    expect(imported.content).toEqual({ hash: reference.hash, bytes: body.length, media_type: "text/markdown; charset=utf-8" });
    expect(imported.provenance).toEqual(expect.objectContaining({
      kind: "interoperability",
      source: expect.objectContaining({
        kind: "agents-md",
        source_revision: plan.actions[0]!.source.observation.observation_identity,
        hash: reference.hash,
        import_policy: expect.objectContaining({ contract: "aira.dev/steering-agents-import-policy/v1" }),
        agents_observation: expect.objectContaining({
          source_path: "AGENTS.md",
          source: { hash: reference.hash, bytes: body.length, media_type: "text/markdown; charset=utf-8" },
          scope: { root: ".", depth: 0 },
        }),
      }),
    }));
    expect(imported.provenance.kind === "interoperability" && imported.provenance.source.kind === "agents-md" &&
      imported.provenance.source.agents_observation?.provenance.source_type).toBe("AGENTS.md");
  });

  test("does not synthesize structured rules or enforcement from prose", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "Never edit migrations. Run unit tests before committing.\n");
    const plan = await planned(value);
    const action = plan.actions[0];
    if (action?.kind !== "create") throw new Error("expected create action");
    const revision = constructSteeringAgentsImportRevision(action, {
      at: agentsImportAt,
      by: { kind: "human", id: "local" },
      operation: operationIdSchema.parse("operation_agents_import_construction"),
      channel: "api",
    });
    expect(revision.rules).toEqual([]);
    expect(revision.default_enforcement).toEqual([]);

    const claimedEnforceable = steeringResourceRevisionSchema.parse({
      ...revision,
      default_authority: "enforceable",
      default_enforcement: [{
        kind: "capability-policy",
        policy: { id: "policy_agents_raw", revision: "rev_one", hash: revision.identity.hash },
      }],
    });
    const issues = validateAgentsImportRawResource(claimedEnforceable).map((issue) => issue.code);
    expect(issues).toContain("agents-import-authority-invalid");
    expect(issues).toContain("agents-import-enforcement-forbidden");
  });
});

describe("AGENTS import planning, scope, and resolver coexistence", () => {
  test("imports a batch atomically and maps root, sibling, and deeper scopes through the existing resolver", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root\n");
    await putAgents(value.root, "packages/api/AGENTS.md", "api\n");
    await putAgents(value.root, "packages/api/src/AGENTS.md", "api source\n");
    await putAgents(value.root, "packages/web/AGENTS.md", "web\n");
    const plan = await planned(value);
    expect(plan.actions.map((action) => action.kind)).toEqual(["create", "create", "create", "create"]);
    const applied = await applyCurrentAgentsImport(value, plan, "operation_agents_import_batch");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.result.created_resources).toHaveLength(4);
    const loaded = await value.store.loadRegistry("acme");
    expect(String(loaded.registry.generation)).toBe("0");

    const api = resolveCurrent(loaded, ["packages/api/src/user.ts"]);
    expect(api.status).toBe("resolved");
    if (api.status !== "resolved") return;
    const apiPaths = api.included_resources.filter((entry) => entry.revision.layer === "interoperability")
      .map((entry) => entry.revision.provenance.kind === "interoperability" && entry.revision.provenance.source.kind === "agents-md" ?
        entry.revision.provenance.source.agents_observation?.source_path : undefined).sort();
    expect(apiPaths).toEqual(["AGENTS.md", "packages/api/AGENTS.md", "packages/api/src/AGENTS.md"]);
    expect(api.applicable_rules).toEqual([]);
    expect(api.effective_rules).toEqual([]);

    const web = resolveCurrent(loaded, ["packages/web/src/page.ts"]);
    expect(web.status).toBe("resolved");
    if (web.status !== "resolved") return;
    const webPaths = web.included_resources.filter((entry) => entry.revision.layer === "interoperability")
      .map((entry) => entry.revision.provenance.kind === "interoperability" && entry.revision.provenance.source.kind === "agents-md" ?
        entry.revision.provenance.source.agents_observation?.source_path : undefined).sort();
    expect(webPaths).toEqual(["AGENTS.md", "packages/web/AGENTS.md"]);

    const imported = activeRevisions(loaded).filter((revision) => revision.layer === "interoperability")
      .sort(compareAgentsImportedGuidance);
    expect(imported.map((revision) => revision.provenance.kind === "interoperability" && revision.provenance.source.kind === "agents-md" ?
      revision.provenance.source.agents_observation?.source_path : undefined)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "packages/web/AGENTS.md",
      "packages/api/src/AGENTS.md",
    ]);
    const nested = imported.find((revision) => revision.provenance.kind === "interoperability" && revision.provenance.source.kind === "agents-md" &&
      revision.provenance.source.agents_observation?.source_path === "packages/api/AGENTS.md")!;
    expect(nested.scope).toEqual({ kind: "path", selectors: [{ kind: "tree", path: "packages/api" }] });
  });

  test("supports exact partial selection, updates, unchanged no-op, and never infers retirement", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root A\n");
    await putAgents(value.root, "packages/api/AGENTS.md", "api A\n");
    const rootOnly = await planned(value, ["AGENTS.md"]);
    expect(rootOnly.selection.action_ids).toHaveLength(1);
    const first = await applyCurrentAgentsImport(value, rootOnly, "operation_agents_import_root_only");
    expect(first.ok).toBe(true);
    const afterFirst = await value.store.loadRegistry("acme");
    expect(afterFirst.registry.resources).toHaveLength(1);

    const remaining = await planned(value);
    expect(remaining.actions.map((action) => action.kind).sort()).toEqual(["create", "unchanged"]);
    const second = await applyCurrentAgentsImport(value, remaining, "operation_agents_import_remaining");
    expect(second.ok).toBe(true);
    const afterSecond = await value.store.loadRegistry("acme");
    expect(String(afterSecond.registry.generation)).toBe("1");

    await writeFile(join(value.root, "AGENTS.md"), "root B\n");
    const update = await planned(value, ["AGENTS.md"]);
    expect(update.actions.find((action) => action.source.observation.source_path === "AGENTS.md")?.kind).toBe("update");
    const updated = await applyCurrentAgentsImport(value, update, "operation_agents_import_update");
    expect(updated.ok).toBe(true);
    const afterUpdate = await value.store.loadRegistry("acme");
    expect(String(afterUpdate.registry.generation)).toBe("2");

    const unchanged = await planned(value, ["AGENTS.md"]);
    const beforeNoOp = await value.store.loadRegistry("acme");
    const noOp = await applyCurrentAgentsImport(value, unchanged, "operation_agents_import_noop");
    expect(noOp.ok).toBe(true);
    if (noOp.ok) expect(noOp.result).toEqual(expect.objectContaining({ status: "no-op", committed: false }));
    expect((await value.store.loadRegistry("acme")).head).toEqual(beforeNoOp.head);

    await rm(join(value.root, "AGENTS.md"));
    const absent = await planned(value);
    expect(absent.actions.map((action) => action.source.observation.source_path)).toEqual(["packages/api/AGENTS.md"]);
    const afterRemoval = await value.store.loadRegistry("acme");
    expect(afterRemoval.registry.resources).toHaveLength(2);
  });

  test("treats an imported source move as a new v1 resource and retains the old authority", async () => {
    const value = await context();
    const rootSource = await putAgents(value.root, "AGENTS.md", "move me\n");
    const initial = await applyCurrentAgentsImport(value, await planned(value), "operation_agents_import_move_base");
    expect(initial.ok).toBe(true);
    const rootId = initial.ok ? initial.result.created_resources[0]!.id : undefined;
    await mkdir(join(value.root, "services", "api"), { recursive: true });
    await rename(rootSource, join(value.root, "services", "api", "AGENTS.md"));
    const moved = await planned(value);
    expect(moved.actions).toEqual([expect.objectContaining({ kind: "create", source: expect.objectContaining({
      observation: expect.objectContaining({ source_path: "services/api/AGENTS.md" }),
    }) })]);
    const applied = await applyCurrentAgentsImport(value, moved, "operation_agents_import_move_new_identity");
    expect(applied.ok).toBe(true);
    const registry = await value.store.loadRegistry("acme");
    expect(registry.registry.resources).toHaveLength(2);
    expect(registry.registry.resources.some((resource) => resource.id === rootId && resource.status === "active")).toBe(true);
  });

  test("rejects invalid source selection and retired mapped identities without auto-reactivation", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root\n");
    const invalidSelection = await currentAgentsImportPlan(value, ["missing/AGENTS.md"]);
    expect(invalidSelection.ok).toBe(false);
    if (!invalidSelection.ok) expect(invalidSelection.issues.map((issue) => issue.code)).toContain("agents-import-partial-selection-invalid");

    const first = await applyCurrentAgentsImport(value, await planned(value), "operation_agents_import_for_retire");
    expect(first.ok).toBe(true);
    const current = await value.store.loadRegistry("acme");
    const id = current.registry.resources[0]!.id;
    await value.store.commit(retire(current, id, "operation_agents_import_retire"));
    const conflict = await planned(value);
    expect(conflict.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "conflict", issues: expect.arrayContaining([
      expect.objectContaining({ code: "agents-import-mapping-conflict", detail: "retired-resource-id" }),
    ]) })]));
    expect(conflict.selection.action_ids).toEqual([]);
  });

  test("retains native structured authority while contradictory AGENTS prose remains attributed guidance", async () => {
    const native = nativeRevision();
    const sealed = {
      revision: steeringResourceRevisionSchema.parse({
        ...native.revision,
        default_override_policy: "sealed",
        rules: native.revision.rules.map((rule) => ({ ...rule, override_policy: "sealed" })),
      }),
      body: native.body,
    };
    const value = await createdRegistry([sealed]);
    clean.push(value.cleanup);
    await putAgents(value.root, "AGENTS.md", "Handlers may access DB directly. Never edit migrations.\n");
    const plan = await currentAgentsImportPlan(value);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const applied = await applyCurrentAgentsImport(value, plan.plan, "operation_agents_import_native_coexistence");
    expect(applied.ok).toBe(true);
    const loaded = await value.store.loadRegistry("acme");
    const resolution = resolveCurrent(loaded, ["src/auth/handler.ts"]);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.effective_rules).toHaveLength(1);
    expect(String(resolution.effective_rules[0]?.semantics.key)).toBe("topic.architecture.data-access");
    expect(resolution.included_resources.filter((entry) => entry.revision.layer === "interoperability")).toHaveLength(1);
    expect(resolution.applicable_rules.every((rule) => rule.resource.id !== "interop.steering.agents-md")).toBe(true);
  });
});

describe("AGENTS import freshness, authorization, and CAS", () => {
  test("rejects byte mutation, same-byte replacement, movement, disappearance, and unsafe source reinspection", async () => {
    const mutation = await context();
    await putAgents(mutation.root, "AGENTS.md", "before\n");
    const mutationPlan = await planned(mutation);
    await writeFile(join(mutation.root, "AGENTS.md"), "after\n");
    const mutationResult = await applyCurrentAgentsImport(mutation, mutationPlan, "operation_agents_import_stale_bytes");
    expect(mutationResult.ok).toBe(false);
    if (!mutationResult.ok) expect(mutationResult.issues).toContainEqual(expect.objectContaining({
      code: "agents-import-source-stale", reasons: expect.arrayContaining(["bytes-changed"]),
    }));

    const replacement = await context();
    const source = await putAgents(replacement.root, "AGENTS.md", "same\n");
    const replacementPlan = await planned(replacement);
    const temporary = join(replacement.root, "replacement.tmp");
    await writeFile(temporary, await readFile(source));
    await rename(temporary, source);
    const replacementResult = await applyCurrentAgentsImport(replacement, replacementPlan, "operation_agents_import_stale_replacement");
    expect(replacementResult.ok).toBe(false);
    if (!replacementResult.ok) expect(replacementResult.issues).toContainEqual(expect.objectContaining({
      code: "agents-import-source-stale", reasons: expect.arrayContaining(["source-replaced"]),
    }));

    const moved = await context();
    const movedSource = await putAgents(moved.root, "AGENTS.md", "move\n");
    const movedPlan = await planned(moved);
    await mkdir(join(moved.root, "packages", "api"), { recursive: true });
    await rename(movedSource, join(moved.root, "packages", "api", "AGENTS.md"));
    const movedResult = await applyCurrentAgentsImport(moved, movedPlan, "operation_agents_import_stale_move");
    expect(movedResult.ok).toBe(false);
    if (!movedResult.ok) expect(movedResult.issues).toContainEqual(expect.objectContaining({
      code: "agents-import-source-stale", reasons: expect.arrayContaining(["source-path-changed", "scope-root-changed"]),
    }));

    const missing = await context();
    const missingSource = await putAgents(missing.root, "AGENTS.md", "gone\n");
    const missingPlan = await planned(missing);
    await rm(missingSource);
    const missingResult = await applyCurrentAgentsImport(missing, missingPlan, "operation_agents_import_missing");
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.issues.map((issue) => issue.code)).toContain("agents-import-source-missing");

    const unsafe = await context();
    const unsafeSource = await putAgents(unsafe.root, "AGENTS.md", "unsafe\n");
    const unsafePlan = await planned(unsafe);
    await rename(unsafeSource, join(unsafe.root, "replacement.md"));
    await symlink(join(unsafe.root, "replacement.md"), join(unsafe.root, "AGENTS.md"));
    const unsafeResult = await applyCurrentAgentsImport(unsafe, unsafePlan, "operation_agents_import_unsafe");
    expect(unsafeResult.ok).toBe(false);
    if (!unsafeResult.ok) expect(unsafeResult.issues.map((issue) => issue.code)).toContain("agents-import-source-unsafe");
  });

  test("reports exact registry freshness independently and together with source freshness", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root\n");
    const first = await applyCurrentAgentsImport(value, await planned(value), "operation_agents_import_registry_base");
    expect(first.ok).toBe(true);
    const registryPlan = await planned(value);
    const current = await value.store.loadRegistry("acme");
    const security = nativeRevision("# Security\n", "1", undefined, "steering.security");
    await value.store.commit(publish(current, security, "operation_agents_import_registry_change"), [security]);
    const registryResult = await applyCurrentAgentsImport(value, registryPlan, "operation_agents_import_registry_stale");
    expect(registryResult.ok).toBe(false);
    if (!registryResult.ok) expect(registryResult.issues.map((issue) => issue.code)).toContain("agents-import-registry-stale");

    const bothPlan = await planned(value);
    await writeFile(join(value.root, "AGENTS.md"), "changed\n");
    const changed = await value.store.loadRegistry("acme");
    const operations = nativeRevision("# Operations\n", "1", undefined, "project.steering.registry-change");
    await value.store.commit(publish(changed, operations, "operation_agents_import_registry_change_both"), [operations]);
    const both = await applyCurrentAgentsImport(value, bothPlan, "operation_agents_import_both_stale");
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "agents-import-source-stale",
      "agents-import-registry-stale",
    ]));
  });

  test("requires human authorization and converges through SteeringStore OperationId semantics", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root\n");
    const plan = await planned(value);
    const missing = await applySteeringAgentsImport({ project_root: value.root, store: value.store, plan,
      operation: "operation_agents_import_missing_authorization" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((issue) => issue.code)).toContain("agents-import-authorization-required");

    const worker = await applySteeringAgentsImport({ project_root: value.root, store: value.store, plan,
      operation: "operation_agents_import_worker_authorization",
      authorization: { ...agentsImportAuthorization(plan), by: { kind: "worker", id: "worker", implementation: "test" } } });
    expect(worker.ok).toBe(false);
    if (!worker.ok) expect(worker.issues.map((issue) => issue.code)).toContain("agents-import-worker-unauthorized");
    const model = await applySteeringAgentsImport({ project_root: value.root, store: value.store, plan,
      operation: "operation_agents_import_model_authorization",
      authorization: { ...agentsImportAuthorization(plan), by: { kind: "model", id: "model", implementation: "test" } } });
    expect(model.ok).toBe(false);
    if (!model.ok) expect(model.issues.map((issue) => issue.code)).toContain("agents-import-worker-unauthorized");

    const operation = "operation_agents_import_replay";
    const first = await applyCurrentAgentsImport(value, plan, operation);
    const replay = await applyCurrentAgentsImport(value, plan, operation);
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.result).toEqual(expect.objectContaining({ status: "replayed", replayed: true }));

    await writeFile(join(value.root, "AGENTS.md"), "later\n");
    const later = await planned(value);
    await expect(applyCurrentAgentsImport(value, later, operation)).rejects.toBeInstanceOf(StorageError);
  });

  test("same plan and OperationId converge to one committed result plus replay", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root\n");
    const plan = await planned(value);
    const operation = "operation_agents_import_same_operation";
    const results = await Promise.all([
      applyCurrentAgentsImport(value, plan, operation),
      applyCurrentAgentsImport(value, plan, operation),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const statuses = results.filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
      .map((result) => result.result.status).sort();
    expect(statuses).toEqual(["committed", "replayed"]);
  });

  test("an older exact AGENTS update loses CAS after another import updates the same mapped resource", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "A\n");
    const initial = await applyCurrentAgentsImport(value, await planned(value), "operation_agents_import_same_resource_base");
    expect(initial.ok).toBe(true);
    await writeFile(join(value.root, "AGENTS.md"), "B\n");
    const plan = await planned(value);
    const first = await applyCurrentAgentsImport(value, plan, "operation_agents_import_same_resource_first");
    expect(first.ok).toBe(true);
    const second = await applyCurrentAgentsImport(value, plan, "operation_agents_import_same_resource_second");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.issues.map((issue) => issue.code)).toContain("agents-import-registry-stale");
  });

  test("different CAS writers from the same plan leave one authority winner", async () => {
    const value = await context();
    await putAgents(value.root, "AGENTS.md", "root\n");
    const plan = await planned(value);
    const results = await Promise.all([
      applyCurrentAgentsImport(value, plan, "operation_agents_import_race_a"),
      applyCurrentAgentsImport(value, plan, "operation_agents_import_race_b"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok && result.issues.some((issue) => issue.code === "agents-import-registry-stale"))).toBeDefined();
  });
});
