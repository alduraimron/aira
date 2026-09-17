import type { OperationId } from "../spec/domain/ids";
import type { BlobInput } from "./types";
import type {
  SteeringCommit,
  SteeringHead,
  SteeringHistoryOptions,
  SteeringLoadMode,
  SteeringRevisionPublication,
  SteeringStoreSnapshot,
  SteeringTransaction,
  SteeringTransactionResult,
  SteeringVerificationReport,
} from "./steering-types";

/**
 * Provider-neutral authority port for the one project-level Steering registry.
 * Every mutation carries an explicit HEAD/generation/resource CAS expectation.
 */
export interface SteeringStore {
  createRegistry(
    transaction: SteeringTransaction,
    revisions?: readonly SteeringRevisionPublication[],
    blobs?: readonly BlobInput[],
  ): Promise<SteeringTransactionResult>;
  commit(
    transaction: SteeringTransaction,
    revisions?: readonly SteeringRevisionPublication[],
    blobs?: readonly BlobInput[],
  ): Promise<SteeringTransactionResult>;
  loadRegistry(project: SteeringHead["project"], mode?: SteeringLoadMode): Promise<SteeringStoreSnapshot>;
  inspectHead(project: SteeringHead["project"]): Promise<SteeringHead>;
  history(project: SteeringHead["project"], options?: SteeringHistoryOptions): Promise<readonly SteeringCommit[]>;
  findCommittedOperation(project: SteeringHead["project"], operation: OperationId): Promise<SteeringCommit | null>;
  verifyHistory(project: SteeringHead["project"]): Promise<SteeringVerificationReport>;
}
