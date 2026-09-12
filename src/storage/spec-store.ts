import type { SpecId, OperationId } from "../spec/domain/ids";
import type { BlobInput, HistoryOptions, LoadMode, StoreCommit, StoreHead, StoreSnapshot, StoreTransaction, TransactionResult, VerificationReport } from "./types";

/** Core computes domain transitions before entry. Locks cover publication, never external work.
 * A review may reload HEAD after run-only work while retaining its domain review generation.
 */
export interface SpecStore {
  createSpec(transaction: StoreTransaction, blobs?: readonly BlobInput[]): Promise<TransactionResult>;
  commit(transaction: StoreTransaction, blobs?: readonly BlobInput[]): Promise<TransactionResult>;
  loadSpec(spec: SpecId, mode?: LoadMode): Promise<StoreSnapshot>;
  inspectHead(spec: SpecId): Promise<StoreHead>;
  history(spec: SpecId, options?: HistoryOptions): Promise<readonly StoreCommit[]>;
  findCommittedOperation(spec: SpecId, operation: OperationId): Promise<StoreCommit | null>;
  verifySpecHistory(spec: SpecId): Promise<VerificationReport>;
}
