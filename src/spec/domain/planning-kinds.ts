import { z } from "zod";

/** Canonical planning layers. Order here is ontology, not a scheduler cursor. */
export const planningKinds = ["product", "requirements", "architecture", "program-design", "slice-plan", "tasks"] as const;
export const planningKindSchema = z.enum(planningKinds);
export type PlanningKind = z.infer<typeof planningKindSchema>;
export const planningContentContracts = {
  intent: "aira.dev/intent/v1", product: "aira.dev/product/v1", requirements: "aira.dev/requirements/v2",
  architecture: "aira.dev/architecture/v1", "program-design": "aira.dev/program-design/v1",
  "slice-plan": "aira.dev/slice-plan/v1", tasks: "aira.dev/tasks/v2", analysis: "aira.dev/analysis/v2",
  "verification-plan": "aira.dev/verification-plan/v2",
} as const;
