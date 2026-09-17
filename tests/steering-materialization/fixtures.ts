import { steeringResourceRevisionSchema } from "../../src/steering/schema";
import type { SteeringRevisionPublication } from "../../src/storage/steering-types";
import type { SteeringMaterializationPlan } from "../../src/steering-materialization";
import { created, revision } from "../steering-store/fixtures";

export const materializationAt = "2026-08-26T12:00:00.000Z";

export async function materializationContext(publications: readonly SteeringRevisionPublication[] = [revision()]) {
  return created(publications);
}

export function replacementAuthorization(plan: SteeringMaterializationPlan) {
  return {
    schema: "aira.dev/steering-materialization-authorization/v1" as const,
    project: "acme",
    plan: { id: plan.id, hash: plan.hash },
    by: { kind: "human" as const, id: "local" },
    decided_at: materializationAt,
    channel: "api" as const,
  };
}

export function customRevision(): SteeringRevisionPublication {
  const base = revision("# API conventions\n\nUse versioned endpoints.\n");
  return {
    body: base.body,
    revision: steeringResourceRevisionSchema.parse({
      ...base.revision,
      identity: { id: "project.steering.api" as never, revision: "1", hash: base.revision.identity.hash },
      kind: "custom",
      custom_kind: "api-conventions",
      rules: [],
      metadata: { title: "API conventions", labels: ["api"] },
    }),
  };
}
