import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type { taskExecutionStateSchema, taskExecutionStatusSchema, taskDefinitionReferenceSchema, claimRecordSchema,
  attemptRecordSchema, attemptAuthoritySchema, executionRunSchema, runBindingSchema, executionProfileSchema } from "./schema";
export type TaskExecutionState = z.infer<typeof taskExecutionStateSchema>;
export type TaskExecutionStatus = z.infer<typeof taskExecutionStatusSchema>;
export type TaskDefinitionReference = z.infer<typeof taskDefinitionReferenceSchema>;
export type ClaimRecord = z.infer<typeof claimRecordSchema>;
export type AttemptRecord = DeepReadonly<z.infer<typeof attemptRecordSchema>>;
export type AttemptAuthority = z.infer<typeof attemptAuthoritySchema>;
export type ExecutionRun = z.infer<typeof executionRunSchema>;
export type RunBinding = z.infer<typeof runBindingSchema>;
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
