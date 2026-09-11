import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type { taskDefinitionSchema, tasksSchema, completionConditionSchema } from "./schema";
export type TaskDefinition = DeepReadonly<z.infer<typeof taskDefinitionSchema>>;
export type Tasks = DeepReadonly<z.infer<typeof tasksSchema>>;
export type CompletionCondition = DeepReadonly<z.infer<typeof completionConditionSchema>>;
