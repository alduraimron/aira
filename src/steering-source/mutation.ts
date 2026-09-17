import { canonical, compareText, exact } from "../spec/domain/primitives";
import {
  steeringSourceObservationSchema,
  type SteeringSourceObservation,
  type SteeringSourceObservationChangeReason,
  type SteeringSourceObservationComparison,
} from "./contract";

function stableReasons(reasons: readonly SteeringSourceObservationChangeReason[]): SteeringSourceObservationChangeReason[] {
  return [...new Set(reasons)].sort(compareText);
}

/**
 * Pure exact-review comparison for later adoption preflight. Timestamps are not
 * content identity. A changed path, exact byte hash, parsed identity, semantic
 * metadata, provenance, or opened filesystem object makes the proposal stale.
 */
export function compareSteeringSourceObservations(
  reviewedValue: SteeringSourceObservation | unknown,
  currentValue: SteeringSourceObservation | unknown,
): SteeringSourceObservationComparison {
  const reviewedResult = steeringSourceObservationSchema.safeParse(reviewedValue);
  const currentResult = steeringSourceObservationSchema.safeParse(currentValue);
  if (!reviewedResult.success || !currentResult.success) return Object.freeze({
    status: "invalid" as const,
    reasons: Object.freeze(["source-observation-invalid" as const]),
  });
  const reviewed = reviewedResult.data, current = currentResult.data;
  const reasons: SteeringSourceObservationChangeReason[] = [];
  if (reviewed.discovery !== current.discovery) reasons.push("discovery-policy-changed");
  if (reviewed.source_schema !== current.source_schema) reasons.push("source-schema-changed");
  if (reviewed.project !== current.project || !exact(reviewed.control, current.control)) reasons.push("project-changed");
  if (reviewed.source_path !== current.source_path) reasons.push("source-path-changed");
  if (!exact(reviewed.source, current.source)) reasons.push("source-bytes-changed");
  if (!exact(reviewed.body, current.body)) reasons.push("body-bytes-changed");
  if (reviewed.metadata_hash !== current.metadata_hash) reasons.push("metadata-changed");
  if (!exact(reviewed.identity, current.identity)) reasons.push("parsed-identity-changed");
  if (!exact(reviewed.provenance, current.provenance)) reasons.push("provenance-changed");
  if (reviewed.filesystem.kind !== current.filesystem.kind ||
    (reviewed.filesystem.kind === "filesystem" && current.filesystem.kind === "filesystem" &&
      (reviewed.filesystem.device !== current.filesystem.device || reviewed.filesystem.inode !== current.filesystem.inode)))
    reasons.push("source-replaced");
  const stable = Object.freeze(stableReasons(reasons));
  return Object.freeze({ status: stable.length === 0 ? "match" as const : "stale" as const, reasons: stable });
}

export function steeringSourceObservationMatches(
  reviewed: SteeringSourceObservation | unknown,
  current: SteeringSourceObservation | unknown,
): boolean {
  return compareSteeringSourceObservations(reviewed, current).status === "match";
}

/** Deterministic key useful for proposal maps; it is not a resource or content identity. */
export const steeringSourceObservationKey = (observation: SteeringSourceObservation): string => canonical({
  project: observation.project,
  source_path: observation.source_path,
  source: observation.source,
  identity: observation.identity,
  metadata_hash: observation.metadata_hash,
});
