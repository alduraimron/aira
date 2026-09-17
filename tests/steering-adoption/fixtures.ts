import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applySteeringAdoption,
  planSteeringAdoption,
  type SteeringAdoptionPlan,
} from "../../src/steering-adoption";
import { inspectNativeSteering } from "../../src/steering-source";
import { created } from "../steering-store/fixtures";

export const adoptionAt = "2026-08-26T12:00:00.000Z";

export async function adoptionContext() {
  const context = await created();
  const steering = join(context.root, ".aira", "steering");
  await mkdir(steering, { recursive: true });
  return { ...context, steering };
}

export async function planCurrent(
  context: Awaited<ReturnType<typeof adoptionContext>>,
  selection?: readonly string[],
) {
  const inspection = await inspectNativeSteering(context.root, { project: "acme" });
  const registry = await context.store.loadRegistry("acme");
  return planSteeringAdoption({ inspection, registry, ...(selection === undefined ? {} : { selection }) });
}

export function authorization(plan: SteeringAdoptionPlan) {
  return {
    schema: "aira.dev/steering-adoption-authorization/v1" as const,
    project: "acme",
    plan: { id: plan.id, hash: plan.hash },
    by: { kind: "human" as const, id: "local" },
    decided_at: adoptionAt,
    channel: "api" as const,
  };
}

export async function applyCurrent(
  context: Awaited<ReturnType<typeof adoptionContext>>,
  plan: SteeringAdoptionPlan,
  operation: string,
) {
  return applySteeringAdoption({
    project_root: context.root,
    store: context.store,
    plan,
    operation,
    authorization: authorization(plan),
  });
}
