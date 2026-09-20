import { inspectAgentsInterop } from "../../src/steering-agents";
import {
  applySteeringAgentsImport,
  planSteeringAgentsImport,
  type SteeringAgentsImportPlan,
} from "../../src/steering-agents-import";
import { StorageError } from "../../src/storage/errors";
import type { SteeringStoreSnapshot } from "../../src/storage/steering-types";

export const agentsImportAt = "2026-08-26T12:00:00.000Z";

export async function currentAgentsImportPlan(
  context: { readonly root: string; readonly store: import("../../src/storage/file/steering-store").FileSteeringStore },
  selection?: readonly string[],
) {
  const inspection = await inspectAgentsInterop(context.root, { project: "acme" });
  let registry: SteeringStoreSnapshot | null;
  try { registry = await context.store.loadRegistry("acme"); }
  catch (error) {
    if (error instanceof StorageError && error.code === "STORE_NOT_FOUND") registry = null;
    else throw error;
  }
  return planSteeringAgentsImport({ inspection, registry, ...(selection === undefined ? {} : { selection }) });
}

export function agentsImportAuthorization(plan: SteeringAgentsImportPlan) {
  return {
    schema: "aira.dev/steering-agents-import-authorization/v1" as const,
    project: "acme",
    plan: { id: plan.id, hash: plan.hash },
    by: { kind: "human" as const, id: "local" },
    decided_at: agentsImportAt,
    channel: "api" as const,
  };
}

export async function applyCurrentAgentsImport(
  context: { readonly root: string; readonly store: import("../../src/storage/file/steering-store").FileSteeringStore },
  plan: SteeringAgentsImportPlan,
  operation: string,
) {
  return applySteeringAgentsImport({
    project_root: context.root,
    store: context.store,
    plan,
    operation,
    authorization: agentsImportAuthorization(plan),
  });
}
