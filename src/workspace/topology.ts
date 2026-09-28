import { z } from "zod";
import { nonBlankSchema } from "../spec/domain/primitives";

/** Physical relationship only. Neither root separation nor a worktree is a sandbox. */
export const workspaceTopologySchema = z.enum(["in-place", "isolated-local", "copied-snapshot"]);
export const operationalRootSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local-absolute"), path: z.string().max(4096).regex(/^\/(?:[^/\u0000]+(?:\/[^/\u0000]+)*)?$/)
    .refine((path) => path.split("/").every((part) => part !== "." && part !== ".."), "workspace-topology-incompatible") }),
  z.strictObject({ kind: z.literal("provider-locator"), locator: nonBlankSchema.max(4096) }),
]);
export const workspaceRootsSchema = z.strictObject({
  control: operationalRootSchema, execution: operationalRootSchema,
  relationship: z.enum(["same-root", "separate-root"]),
});
export type WorkspaceTopology = z.infer<typeof workspaceTopologySchema>;
export type OperationalRoot = z.infer<typeof operationalRootSchema>;
