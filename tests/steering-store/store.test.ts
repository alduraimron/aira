import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { steeringTransactionSchema } from "../../src/storage/steering-types";
import { steeringGenerationSchema } from "../../src/steering/ids";
import { code } from "../storage-v2/fixtures";
import { created, creation, project, publish, retire, revision, temporary } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function setup(initial = false) {
  const publication = revision();
  const context = await created(initial ? [publication] : []);
  clean.push(context.cleanup);
  return { ...context, publication };
}

describe("Steering registry genesis and generations", () => {
  test("SteeringGeneration is a canonical decimal u64, not an unsafe JS number", () => {
    expect(steeringGenerationSchema.safeParse("9007199254740993").success).toBe(true);
    expect(steeringGenerationSchema.safeParse("18446744073709551615").success).toBe(true);
    for (const invalid of [1, "01", "-1", "1.5", "18446744073709551616"])
      expect(steeringGenerationSchema.safeParse(invalid).success).toBe(false);
  });

  test("creates an empty authoritative registry at sequence one and generation zero", async () => {
    const context = await setup();
    expect(String(context.result.sequence)).toBe("1");
    expect(String(context.result.steering_generation)).toBe("0");
    expect(context.result.registry.resources).toEqual([]);
    expect((await context.store.verifyHistory(project)).commits).toBe(1);
  });

  test("genesis may include an exact initial revision and duplicate creation fails", async () => {
    const context = await setup(true);
    expect(context.result.registry.resources[0]?.current).toEqual(context.publication.revision.identity);
    expect(context.result.revisions).toEqual([context.publication.revision]);
    const duplicate = creation("operation_duplicate", [context.publication]);
    await code(context.store.createRegistry(duplicate.transaction, duplicate.publications), "STORE_ALREADY_EXISTS");
  });

  test("semantic mutation advances SteeringGeneration once, every commit advances sequence, and reads do neither", async () => {
    const context = await setup();
    const before = await context.store.loadRegistry(project);
    const published = await context.store.commit(publish(before, context.publication), [context.publication]);
    expect(String(published.sequence)).toBe("2");
    expect(String(published.steering_generation)).toBe("1");
    const loaded = await context.store.loadRegistry(project);
    expect(loaded.head).toEqual(published.head);
    expect(await context.store.inspectHead(project)).toEqual(published.head);
    expect((await context.store.history(project)).length).toBe(2);
  });

  test("retirement advances generation and leaves an immutable tombstone/history", async () => {
    const context = await setup(true);
    const retired = await context.store.commit(retire(context.result));
    expect(String(retired.steering_generation)).toBe("1");
    expect(retired.registry.resources[0]?.status).toBe("retired");
    expect(retired.registry.resources[0]?.current).toBeNull();
    expect(retired.revisions).toEqual([context.publication.revision]);
  });

  test("audit-only metadata advances CommitSequence but not SteeringGeneration or registry state", async () => {
    const context = await setup(true);
    const transaction = steeringTransactionSchema.parse({
      schema: "aira.dev/steering-store-transaction/v1",
      project,
      operation: "operation_steering_audit",
      expected: { head: context.result.head, resources: [] },
      mutation: { kind: "audit", resources: [], reason: "Record registry inspection" },
      actor: { kind: "system", id: "project-control", implementation: "aira-core" },
      registry: context.result.registry,
      events: [{ kind: "steering-registry-inspected", resources: [], payloads: [] }],
    });
    const result = await context.store.commit(transaction);
    expect(String(result.sequence)).toBe("2");
    expect(String(result.steering_generation)).toBe("0");
    expect(result.registry).toEqual(context.result.registry);
  });
});

describe("exact Steering revision and body publication", () => {
  test("publishes raw bytes and updates the exact current revision", async () => {
    const context = await setup(true);
    const second = revision("# Architecture\n\nUse ports and adapters exactly.\n", "2", context.publication.revision);
    const result = await context.store.commit(publish(context.result, second), [second]);
    expect(result.registry.resources[0]?.current).toEqual(second.revision.identity);
    expect(result.revisions).toEqual([context.publication.revision, second.revision]);
    expect(await context.store.blobs.get(second.revision.content.hash)).toEqual(second.body);
  });

  test("raw body hash or byte count mismatch fails closed before HEAD publication", async () => {
    const context = await setup();
    const bad = { ...context.publication, body: new TextEncoder().encode("different bytes") };
    await code(context.store.commit(publish(context.result, context.publication), [bad]), "STORE_INTEGRITY");
    expect((await context.store.inspectHead(project)).commit_id).toBe(context.result.commit_id);
  });

  test("the shared immutable BlobStore reuses identical body bytes", async () => {
    const context = await setup(true);
    const before = await stat(context.store.fs.paths.blob(context.publication.revision.content.hash));
    const security = revision(new TextDecoder().decode(context.publication.body), "1", undefined, "steering.security");
    expect(security.revision.content.hash).toBe(context.publication.revision.content.hash);
    await context.store.commit(publish(context.result, security, "operation_security"), [security]);
    const after = await stat(context.store.fs.paths.blob(security.revision.content.hash));
    expect(`${after.dev}:${after.ino}`).toBe(`${before.dev}:${before.ino}`);
  });

  test("invalid predecessor and rule-history relationships are rejected by pure domain history validation", async () => {
    const context = await setup(true);
    const disconnected = revision("# Architecture\n\nDisconnected.\n", "2");
    await code(context.store.commit(publish(context.result, disconnected), [disconnected]), "STORE_INTEGRITY");
    expect((await context.store.inspectHead(project)).commit_id).toBe(context.result.commit_id);
  });
});

describe("explicit Steering CAS and OperationId idempotency", () => {
  test("correct expected HEAD/generation/resource revision succeeds", async () => {
    const context = await setup();
    const result = await context.store.commit(publish(context.result, context.publication), [context.publication]);
    expect(result.replayed).toBe(false);
  });

  test("stale HEAD, SteeringGeneration, and expected current revision each fail", async () => {
    const context = await setup(true);
    const second = revision("# Architecture v2\n", "2", context.publication.revision);
    const stale = publish(context.result, second, "operation_stale_head");
    const security = revision("# Security\n", "1", undefined, "steering.security");
    const advanced = await context.store.commit(publish(context.result, security, "operation_advance"), [security]);
    await code(context.store.commit(stale, [second]), "STORE_CONFLICT");

    const generation = publish(advanced, second, "operation_stale_generation");
    generation.expected!.head.steering_generation = "0" as never;
    await code(context.store.commit(generation, [second]), "STORE_CONFLICT");

    const resource = publish(advanced, second, "operation_stale_resource");
    const expectation = resource.expected!.resources[0]!;
    if (expectation.status !== "active") throw new Error("fixture expectation");
    expectation.current = { ...expectation.current, revision: "99" } as never;
    await code(context.store.commit(resource, [second]), "STORE_CONFLICT");
  });

  test("exact OperationId replay returns the original commit, differing intent is reuse conflict", async () => {
    const context = await setup();
    const transaction = publish(context.result, context.publication, "operation_idempotent");
    const first = await context.store.commit(transaction, [context.publication]);
    const later = revision("# Security\n", "1", undefined, "steering.security");
    await context.store.commit(publish(first, later, "operation_later"), [later]);
    const replay = await context.store.commit(transaction, [context.publication]);
    expect(replay.replayed).toBe(true);
    expect(replay.commit_id).toBe(first.commit_id);
    expect((await context.store.findCommittedOperation(project, transaction.operation))?.id).toBe(first.commit_id);
    expect((await context.store.verifyHistory(project)).commits).toBe(3);

    const other = revision("# Different security intent\n", "1", undefined, "steering.security");
    const conflicting = publish(context.result, other, "operation_idempotent");
    await code(context.store.commit(conflicting, [other]), "STORE_OPERATION_REUSE");
  });

  test("worker/model identities are not accepted as Steering publication authority", async () => {
    const context = await setup();
    const transaction = publish(context.result, context.publication);
    expect(steeringTransactionSchema.safeParse({ ...transaction,
      actor: { kind: "worker", id: "worker-1", implementation: "test" } }).success).toBe(false);
    expect(steeringTransactionSchema.safeParse({ ...transaction,
      actor: { kind: "system", id: "project-control", implementation: "aira-core" } }).success).toBe(true);
  });
});
