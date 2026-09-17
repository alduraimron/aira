import type { BlobStore } from "../blob-store";
import { errno, fail } from "../errors";
import type { SteeringRegistry } from "../steering-types";
import { steeringRegistryRevisionOf } from "../steering-types";
import type { ContentHash } from "../../spec/domain/primitives";
import { exact } from "../../spec/domain/primitives";
import {
  steeringResourceRevisionSchema,
  type SteeringResourceRevisionValue,
} from "../../steering/schema";
import { validateSteeringRevisionHistory } from "../../steering/resources";
import { canonicalJSON, decodeCanonical } from "./canonical-json";

async function requiredBlob(store: BlobStore, hash: ContentHash, subject: string): Promise<Uint8Array> {
  try { return await store.get(hash); }
  catch (error) {
    if (errno(error, "STORE_NOT_FOUND")) fail("STORE_INTEGRITY", `Required Steering ${subject} blob is missing: ${hash}`);
    throw error;
  }
}

function exactRevisionExists(revisions: readonly SteeringResourceRevisionValue[], reference: unknown): boolean {
  return revisions.some((revision) => exact(revision.identity, reference));
}

/** Validate the complete authoritative registry closure without traversing commit history. */
export async function readSteeringRevisions(
  store: BlobStore,
  registry: SteeringRegistry,
  full: boolean,
): Promise<{ revisions: SteeringResourceRevisionValue[]; blobs: Set<ContentHash> }> {
  const revisions: SteeringResourceRevisionValue[] = [];
  const blobs = new Set<ContentHash>();
  for (const resource of registry.resources) for (const summary of resource.revisions) {
    blobs.add(summary.record.hash);
    blobs.add(summary.content.hash);
    const bytes = await requiredBlob(store, summary.record.hash, "revision-record");
    if (bytes.length !== summary.record.bytes) fail("STORE_INTEGRITY", "Steering revision record byte size mismatch");
    const value = decodeCanonical(bytes, "STORE_INTEGRITY");
    if (value && typeof value === "object" && "schema" in value && value.schema !== "aira.dev/steering-resource/v1")
      fail("STORE_SCHEMA_UNSUPPORTED", `Unsupported Steering resource record: ${String(value.schema)}`);
    const parsed = steeringResourceRevisionSchema.safeParse(value);
    if (!parsed.success) fail("STORE_INTEGRITY", `Invalid Steering revision record: ${parsed.error.message}`);
    if (canonicalJSON(parsed.data) !== canonicalJSON(value) || !exact(steeringRegistryRevisionOf(parsed.data), summary))
      fail("STORE_INTEGRITY", "Steering registry revision reference does not match its immutable record");
    if (parsed.data.provenance.kind === "project" && parsed.data.provenance.project !== registry.project)
      fail("STORE_INTEGRITY", "Steering revision project provenance does not match registry authority");
    revisions.push(parsed.data);
    if (full) {
      const body = await requiredBlob(store, parsed.data.content.hash, "body");
      if (body.length !== parsed.data.content.bytes) fail("STORE_INTEGRITY", "Steering body byte size mismatch");
    }
  }

  const historyIssues = validateSteeringRevisionHistory(revisions);
  if (historyIssues.length) fail("STORE_INTEGRITY", `Invalid Steering revision history: ${JSON.stringify(historyIssues)}`);

  for (const resource of registry.resources) {
    const history = resource.revisions.map((summary) => revisions.find((revision) => exact(revision.identity, summary.identity))!);
    for (let index = 0; index < history.length; index++) {
      const revision = history[index]!;
      const predecessor = index === 0 ? undefined : history[index - 1];
      if (predecessor === undefined ? revision.supersedes !== undefined : !exact(revision.supersedes, predecessor.identity))
        fail("STORE_INTEGRITY", "Authoritative Steering revision history is not one exact linear chain");
    }
  }

  for (const revision of revisions) {
    for (const parent of revision.composition.parents)
      if (!exactRevisionExists(revisions, parent)) fail("STORE_INTEGRITY", "Steering composition parent is unavailable from the registry");
    for (const override of revision.composition.overrides)
      if (!exactRevisionExists(revisions, override.target.resource)) fail("STORE_INTEGRITY", "Steering override target is unavailable from the registry");
    if (revision.provenance.kind === "project" && revision.provenance.adopted_from?.kind === "steering-revision" &&
      !exactRevisionExists(revisions, revision.provenance.adopted_from.revision))
      fail("STORE_INTEGRITY", "Steering adoption source is unavailable from the registry");
  }
  return { revisions, blobs };
}
