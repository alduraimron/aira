import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { applySteeringAdoption, planSteeringAdoption } from "../../src/steering-adoption";
import { inspectNativeSteering } from "../../src/steering-source";
import { created } from "../steering-store/fixtures";
import { putSource } from "../steering-native-source/fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

test("adopts one inspected source", async () => {
  const context = await created();
  clean.push(context.cleanup);
  const steering = join(context.root, ".aira", "steering");
  await mkdir(steering, { recursive: true });
  await putSource(steering, "architecture.md");
  const inspection = await inspectNativeSteering(context.root, { project: "acme" });
  const planned = planSteeringAdoption({ inspection, registry: context.result });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  const applied = await applySteeringAdoption({
    project_root: context.root,
    store: context.store,
    plan: planned.plan,
    operation: "operation_adopt_architecture",
    authorization: {
      schema: "aira.dev/steering-adoption-authorization/v1",
      project: "acme",
      plan: { id: planned.plan.id, hash: planned.plan.hash },
      by: { kind: "human", id: "local" },
      decided_at: "2026-08-26T12:00:00.000Z",
      channel: "api",
    },
  });
  expect(applied.ok).toBe(true);
  if (applied.ok) expect(applied.result.created_revisions).toHaveLength(1);
});
