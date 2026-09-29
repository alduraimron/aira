export { localInspectionPolicy } from "./policy";
export { inspectWorkspaceLocal, inspectWorkspaceLocalTree, recheckWorkspaceLocalTree } from "./inspect";
export { compareLocalInspections, type LocalDrift, type DriftReason } from "./comparison";
export type { WorkspaceLocalInspection, LocalTreeObservation, LocalTreeEntry, InspectionIssue,
  InspectWorkspaceLocalOptions, InspectLocalTreeOptions, LocalTreeCapture, SnapshotEvidence } from "./types";
