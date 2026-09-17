import type { SteeringSnapshot } from "../steering/snapshot";
import type { SteeringSnapshotId } from "../steering/ids";
import type {
  SteeringSnapshotPublicationMetadata,
  SteeringSnapshotPutResult,
  SteeringSnapshotRecord,
  SteeringSnapshotVerificationReport,
} from "./steering-snapshot-types";

/**
 * Provider-neutral port for immutable resolved Steering evidence. Snapshot
 * publication is separate from authoritative Steering registry mutation.
 */
export interface SteeringSnapshotStore {
  putSnapshot(
    snapshot: SteeringSnapshot,
    metadata: SteeringSnapshotPublicationMetadata,
  ): Promise<SteeringSnapshotPutResult>;
  getSnapshot(snapshotId: SteeringSnapshotId): Promise<SteeringSnapshot>;
  hasSnapshot(snapshotId: SteeringSnapshotId): Promise<boolean>;
  inspectSnapshot(snapshotId: SteeringSnapshotId): Promise<SteeringSnapshotRecord>;
  verifySnapshot(snapshotId: SteeringSnapshotId): Promise<SteeringSnapshotVerificationReport>;
}
