import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type { revisionRequestSchema, revisionResolutionSchema } from "./schema";
export type RevisionRequest = DeepReadonly<z.infer<typeof revisionRequestSchema>>;
export type RevisionResolution = DeepReadonly<z.infer<typeof revisionResolutionSchema>>;
