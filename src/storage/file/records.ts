import type { BlobStore } from "../blob-store";
import { parseRecord, type DomainRecord, type RecordReference } from "../records";
import type { StoreState } from "../types";
import { blobReferenceSchema, exact, type ContentHash } from "../../spec/domain/primitives";
import { artifactReferenceSchema, artifactSubjectSchema, referenceOf, type ArtifactRevision } from "../../spec/domain/artifacts";
import { behavioralAssetPinSchema, type BehavioralAssetPin } from "../../builtins/roles";
import { behavioralAssetReferenceSchema } from "../../builtins/assets";
import { validatePinnedAssets, validateBuiltinBundleContents, type BehavioralAssetCatalog } from "../../builtins/catalog";
import { validateSpecBehavioralBindings } from "../../spec/domain/behavior";
import { fail, errno } from "../errors";
import { canonicalBytes, canonicalJSON, decodeCanonical, hashCanonical } from "./canonical-json";
import { currentLineageValidity } from "../../spec/domain/lineage";
import { identityRegistrySchema, validateIdentityEvolution } from "../../spec/domain/ids";
import { validateRevisionResolution } from "../../revision/policy";
import { validateTaskGraph } from "../../tasks/graph";

export function walk(value: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) visit(value as Record<string, unknown>);
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    // These explicit domain JSON extension maps are opaque bytes, not storage references.
    if ((object.schema === "aira.dev/workspace-handle/v1" && key === "provider_data") ||
      (object.kind === "custom" && (("repository_identity" in object && key === "components") || ("contract" in object && key === "configuration")))) continue;
    walk(child, visit);
  }
}
/** Hash subjects are explicit; self-identities are outside these canonical bodies. */
export function recordBody(record: DomainRecord): unknown {
  if ("asset" in record) { const { asset: _, ...body } = record; return body; }
  if ("identity" in record && typeof record.identity === "object" && record.identity && "hash" in record.identity && record.schema !== "aira.dev/behavioral-asset/v1" && record.schema !== "aira.dev/execution-backend/v1") {
    const { identity: _, ...body } = record; return body;
  }
  return record;
}
export function validateReferenceIdentities(values: readonly unknown[]): void {
  const identities = new Map<string, unknown>();
  for (const value of values) walk(value, (ref) => {
    if (typeof ref.hash !== "string") return;
    let key: string | undefined;
    if (typeof ref.id === "string" && typeof ref.revision === "string") key = `named:${ref.id}@${ref.revision}`;
    else if (typeof ref.id === "string" && ref.id.startsWith("snapshot_") && Object.keys(ref).length === 2) key = `context:${ref.id}`;
    else if (typeof ref.kind === "string" && typeof ref.revision === "string" && Object.keys(ref).length === 3) key = `artifact:${ref.revision}`;
    if (!key) return;
    if (identities.has(key) && !exact(identities.get(key), ref)) fail("STORE_INTEGRITY", `Immutable reference identity rebound: ${key}`);
    identities.set(key, ref);
  });
}
export function logicalRecordKey(record: DomainRecord): string | null {
  if ("identity" in record && typeof record.identity === "object" && record.identity && "id" in record.identity) {
    const identity = record.identity as { id: string; revision?: string };
    return identity.revision === undefined ? null : `${record.schema}:${identity.id}:${identity.revision}`;
  }
  if ("asset" in record) return `${record.schema}:${record.asset.id}:${record.asset.revision}`;
  if ("id" in record && ["aira.dev/artifact-revision/v1", "aira.dev/spec-approval/v1", "aira.dev/human-waiver/v1",
    "aira.dev/attempt/v1", "aira.dev/evidence/v1", "aira.dev/context-snapshot/v1", "aira.dev/revision-request/v1"].includes(record.schema))
    return `${record.schema}:${record.id}`;
  if ("spec_id" in record && "revision" in record) return `${record.schema}:${record.spec_id}:${record.revision}`;
  return null;
}
export function artifactLineageHash(revision: ArtifactRevision): ContentHash {
  return hashCanonical({ created: revision.created, lineage: revision.lineage,
    ...(revision.behavioral_profile ? { behavioral_profile: revision.behavioral_profile } : {}) });
}
function nestedImmutable(records: readonly DomainRecord[]): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const record of records) walk(record, (value) => {
    if (value.schema !== "aira.dev/task-definition/v1" && value.schema !== "aira.dev/verifier/v1") return;
    const parsed = parseRecord(value), key = logicalRecordKey(parsed)!;
    if (result.has(key) && !exact(result.get(key), parsed)) fail("STORE_INTEGRITY", "Nested immutable identity collision");
    result.set(key, parsed);
  });
  return result;
}
export async function readRecords(store: BlobStore, refs: readonly RecordReference[]): Promise<DomainRecord[]> {
  const records: DomainRecord[] = [], names = new Set<string>();
  for (const ref of refs) {
    const bytes = await requiredBlob(store, ref.hash);
    const value = decodeCanonical(bytes, "STORE_INTEGRITY");
    const record = parseRecord(value);
    if (record.schema !== ref.contract || canonicalJSON(record) !== canonicalJSON(value)) fail("STORE_INTEGRITY", "Structured record reference mismatch");
    const key = logicalRecordKey(record);
    if (key && names.has(key)) fail("STORE_INTEGRITY", `Ambiguous immutable record: ${key}`);
    if (key) names.add(key);
    records.push(record);
  }
  return records;
}
async function requiredBlob(store: BlobStore, hash: ContentHash): Promise<Uint8Array> {
  try { return await store.get(hash); }
  catch (error) { if (errno(error, "STORE_NOT_FOUND")) fail("STORE_INTEGRITY", `Required blob is missing: ${hash}`); throw error; }
}
export function checkRecordEvolution(previous: readonly DomainRecord[], next: readonly DomainRecord[], before: StoreState, after: StoreState): void {
  validateReferenceIdentities([before, after, ...previous, ...next]);
  const identities = validateIdentityEvolution(identityRegistrySchema.parse(before.spec.identities), identityRegistrySchema.parse(after.spec.identities));
  if (identities.length) fail("STORE_INTEGRITY", `Identity registry changed: ${JSON.stringify(identities)}`);
  for (const old of previous) {
    const key = logicalRecordKey(old);
    const current = key ? next.find((r) => logicalRecordKey(r) === key) : next.find((r) => exact(r, old));
    if (!current) fail("STORE_INTEGRITY", "Authoritative historical record was removed");
    if (exact(old, current)) continue;
    // The domain's revision request is a state machine, not an immutable decision.
    // Preserve exact initial feedback/provenance and only publish its first terminal resolution.
    if (old.schema === "aira.dev/revision-request/v1" && current.schema === old.schema && old.status === "pending" && current.status !== "pending") {
      const { status: _, ...oldBase } = old;
      if (Object.entries(oldBase).every(([k, v]) => exact(v, (current as unknown as Record<string, unknown>)[k]))) {
        if (current.status === "resolved") {
          const artifact = next.find((r) => r.schema === "aira.dev/artifact-revision/v1" && exact(referenceOf(r), current.resolution.resulting_artifact));
          if (!artifact || artifact.schema !== "aira.dev/artifact-revision/v1" || validateRevisionResolution(old, current.resolution, artifact).length)
            fail("STORE_INTEGRITY", "Revision resolution does not supersede its exact predecessor");
        }
        continue;
      }
    }
    fail("STORE_INTEGRITY", `Immutable named record changed: ${key}`);
  }
  const oldNested = nestedImmutable(previous), newNested = nestedImmutable(next);
  for (const [key, value] of oldNested) if (!newNested.has(key) || !exact(value, newNested.get(key))) fail("STORE_INTEGRITY", "Nested immutable definition changed");
  for (const record of next.filter((r) => !previous.some((old) => exact(old, r)))) {
    const execution = ["aira.dev/attempt/v1", "aira.dev/evidence/v1", "aira.dev/reconciliation/v1"].includes(record.schema) ||
      (record.schema === "aira.dev/context-snapshot/v1" && ["implementation", "verification"].includes(record.phase));
    if (execution ? exact(before.runs, after.runs) : before.spec.generation === after.spec.generation)
      fail("STORE_CONFLICT", "Record mutation requires its scoped domain generation");
  }
}

/** Current closure, never the global blob directory or history. Full mode also checks
 * raw artifact/context/evidence/asset bytes. Structured records are always verified.
 */
export async function validateState(store: BlobStore, state: StoreState, records: readonly DomainRecord[], full: boolean): Promise<Set<ContentHash>> {
  validateReferenceIdentities([state, ...records]);
  const required = new Map<ContentHash, number | null>();
  const add = (hash: ContentHash, size: number | null = null): void => {
    const prior = required.get(hash);
    if (prior !== undefined && prior !== null && size !== null && prior !== size) fail("STORE_INTEGRITY", "Conflicting byte sizes for blob");
    required.set(hash, size ?? prior ?? null);
  };
  for (const ref of state.records) add(ref.hash);
  const revisions = records.filter((r) => r.schema === "aira.dev/artifact-revision/v1");
  const analyses = records.filter((r) => r.schema === "aira.dev/analysis/v1");
  const snapshots = records.filter((r) => r.schema === "aira.dev/behavioral-profile-snapshot/v1");
  const assets = records.filter((r) => r.schema === "aira.dev/behavioral-asset/v1");
  const bundles = records.filter((r) => r.schema === "aira.dev/builtin-bundle/v1");
  const pins: BehavioralAssetPin[] = [];
  const definitions = nestedImmutable(records);
  const values = [state.spec, ...state.runs, ...records, ...state.blobs];
  const has = (schema: DomainRecord["schema"], id: string): boolean => records.some((r) => r.schema === schema && "id" in r && r.id === id);
  if (state.spec.approvals.some((id) => !has("aira.dev/spec-approval/v1", id)) || state.spec.waivers.some((id) => !has("aira.dev/human-waiver/v1", id)) ||
    state.spec.revisions.some((id) => !has("aira.dev/revision-request/v1", id))) fail("STORE_INTEGRITY", "Missing human decision/revision record");
  for (const run of state.runs) {
    if (run.attempts.some((id) => !has("aira.dev/attempt/v1", id)) || run.current_evidence.some((e) => !has("aira.dev/evidence/v1", e.evidence)))
      fail("STORE_INTEGRITY", "Missing run attempt/evidence");
  }
  for (const record of records) {
    if ("spec_id" in record && record.spec_id !== state.spec.id) fail("STORE_INTEGRITY", "Cross-Spec structured record");
    if (record.schema === "aira.dev/spec/v1" || record.schema === "aira.dev/execution-run/v1") fail("STORE_INTEGRITY", "Spec/run snapshots belong in the authoritative state, not its record catalog");
    // Canonical identity-bearing structured bodies and raw asset bytes have different subjects.
    if ("identity" in record && typeof record.identity === "object" && record.identity && "hash" in record.identity) {
      const hash = record.identity.hash as ContentHash;
      if (record.schema !== "aira.dev/behavioral-asset/v1") {
        if (hashCanonical(recordBody(record)) !== hash) fail("STORE_INTEGRITY", "Structured self-identity body mismatch");
      }
      add(hash);
    }
    if (record.schema === "aira.dev/spec-kind-profile/v1" || record.schema === "aira.dev/mode-profile/v1") {
      if (hashCanonical(recordBody(record)) !== record.asset.hash) fail("STORE_INTEGRITY", "Behavioral configuration does not describe its bytes");
      add(record.asset.hash);
    }
    if (record.schema === "aira.dev/context-snapshot/v1") for (const entry of record.entries) {
      add(entry.content_hash, entry.byte_size); if (entry.source) add(entry.source.original_hash);
    }
    if (record.schema === "aira.dev/artifact-revision/v1") {
      const expected = `aira.dev/${record.kind}/v1`;
      const document = records.find((r) => r.schema === expected && "revision" in r && r.revision === record.id);
      if (!document || hashCanonical(document) !== record.content.hash || canonicalBytes(document).length !== record.content.bytes)
        fail("STORE_INTEGRITY", "Artifact revision missing its exact canonical typed content");
    }
  }
  for (const value of values) walk(value, (object) => {
    const blob = blobReferenceSchema.safeParse(object);
    if (blob.success) add(blob.data.hash, blob.data.bytes);
    const ref = artifactReferenceSchema.safeParse(object);
    if (ref.success && !revisions.some((r) => exact(referenceOf(r), ref.data))) fail("STORE_INTEGRITY", "Unknown exact artifact reference");
    const subject = artifactSubjectSchema.safeParse(object);
    if (subject.success) {
      const revision = revisions.find((r) => exact(referenceOf(r), subject.data.artifact));
      if (!revision || artifactLineageHash(revision) !== subject.data.lineage_hash) fail("STORE_INTEGRITY", "Immutable provenance hash mismatch");
    }
    if (typeof object.id === "string" && /^(profile|policy)_/.test(object.id) && typeof object.revision === "string" &&
      typeof object.hash === "string" && Object.keys(object).length === 3) add(object.hash as ContentHash);
    if (object.schema === "aira.dev/spec-decision-policy/v1" || object.schema === "aira.dev/spec-completion-policy/v1" ||
      object.schema === "aira.dev/task-definition/v1" || object.schema === "aira.dev/verifier/v1") {
      const definition = parseRecord(object);
      if (!("identity" in definition) || !("hash" in definition.identity) || hashCanonical(recordBody(definition)) !== definition.identity.hash)
        fail("STORE_INTEGRITY", "Nested definition content hash mismatch");
    }
    if (typeof object.id === "string" && /^[TV][1-9][0-9]*$/.test(object.id) && typeof object.revision === "string" && typeof object.hash === "string") {
      const schema = object.id.startsWith("T") ? "aira.dev/task-definition/v1" : "aira.dev/verifier/v1";
      const definition = definitions.get(`${schema}:${object.id}:${object.revision}`) as { identity: unknown } | undefined;
      if (!definition || !exact(definition.identity, object)) fail("STORE_INTEGRITY", "Unknown exact task/verifier definition");
    }
    if (object.schema === "aira.dev/approved-spec-snapshot/v1" && (object.approvals as string[]).some((id) => !has("aira.dev/spec-approval/v1", id)))
      fail("STORE_INTEGRITY", "Approved snapshot lacks its immutable human decisions");
    const pin = behavioralAssetPinSchema.safeParse(object);
    if (pin.success) pins.push(pin.data);
    const asset = behavioralAssetReferenceSchema.safeParse(object);
    if (asset.success) {
      if (!assets.some((r) => exact(r.identity, asset.data))) fail("STORE_INTEGRITY", "Unknown exact behavioral asset revision");
      const identity = asset.data;
      if (identity.kind === "capability-policy-profile" && !records.some((r) => r.schema === "aira.dev/capability-policy/v1" && exact(r.identity, identity.policy)))
        fail("STORE_INTEGRITY", "Pinned capability asset lacks its exact typed policy body");
      if (identity.kind === "execution-profile" && !records.some((r) => r.schema === "aira.dev/execution-profile/v1" && exact(r.identity, identity.profile)))
        fail("STORE_INTEGRITY", "Pinned execution asset lacks its exact typed execution profile");
      add(asset.data.hash);
    }
    if (typeof object.id === "string" && object.id.startsWith("snapshot_") && typeof object.hash === "string" && Object.keys(object).length === 2) {
      const index = state.records.findIndex((r) => r.hash === object.hash && r.contract === "aira.dev/context-snapshot/v1");
      const target = records[index];
      if (!target || target.schema !== "aira.dev/context-snapshot/v1" || target.id !== object.id) fail("STORE_INTEGRITY", "Missing exact context snapshot");
    }
  });
  for (const document of records.filter((r) => r.schema === "aira.dev/tasks/v1")) {
    const contexts = document.tasks.flatMap((t) => t.context.references).filter((ref) => {
      const index = state.records.findIndex((r) => r.contract === "aira.dev/context-declaration/v1" && r.hash === ref.hash);
      const record = records[index];
      return record?.schema === "aira.dev/context-declaration/v1" && record.id === ref.id;
    });
    const graphIssues = validateTaskGraph(document, {
      requirements: records.flatMap((r) => r.schema === "aira.dev/requirements/v1" ? r.requirements : []),
      decisions: records.flatMap((r) => r.schema === "aira.dev/design/v1" ? r.decisions : []),
      verifiers: [...definitions.values()].flatMap((r) => {
        const record = r as DomainRecord;
        return record.schema === "aira.dev/verifier/v1" ? [record.identity] : [];
      }),
      policies: records.flatMap((r) => r.schema === "aira.dev/capability-policy/v1" ? [r.identity] : []),
      execution_profiles: records.flatMap((r) => r.schema === "aira.dev/execution-profile/v1" ? [r.identity] : []), contexts,
    });
    if (graphIssues.length) fail("STORE_INTEGRITY", `Task reference closure invalid: ${JSON.stringify(graphIssues)}`);
  }
  // Intrinsic lineage closure/cycles are storage integrity; approval/readiness/completion remain Core decisions.
  const issues = currentLineageValidity({ revisions, validations: state.spec.lineage.validations,
    current: [...state.spec.artifacts.current.map((s) => s.artifact), ...state.spec.analyses], proposed: state.spec.artifacts.proposed,
    invalidations: state.spec.lineage.invalidations, analyses, generation: state.spec.generation });
  if (issues.length) fail("STORE_INTEGRITY", `Invalid lineage: ${JSON.stringify(issues)}`);
  if (pins.length || snapshots.length) {
    if (!state.behavioral_environment) fail("STORE_INTEGRITY", "Pinned assets require an explicit compatibility environment");
    const catalog: BehavioralAssetCatalog = {
      assets: assets.map((revision) => {
        const configuration = records.find((r) => (r.schema === "aira.dev/spec-kind-profile/v1" || r.schema === "aira.dev/mode-profile/v1") && exact(r.asset, revision.identity));
        return { revision, verified_content_hash: revision.identity.hash,
          ...(configuration && "asset" in configuration ? { configuration } : {}) };
      }), bundles: bundles.map((manifest) => ({ manifest, verified_content_hash: manifest.identity.hash })),
    };
    const behavioralIssues = [...validatePinnedAssets(pins, catalog, state.behavioral_environment),
      ...bundles.flatMap((b) => validateBuiltinBundleContents(b, catalog, state.behavioral_environment!)),
      ...validateSpecBehavioralBindings(state.spec as Parameters<typeof validateSpecBehavioralBindings>[0], revisions, analyses,
        snapshots.map((snapshot) => ({ snapshot, verified_content_hash: snapshot.identity.hash })), catalog, state.behavioral_environment)];
    if (behavioralIssues.length) fail("STORE_INTEGRITY", `Behavioral closure invalid: ${JSON.stringify(behavioralIssues)}`);
  } else if (revisions.some((r) => r.behavioral_profile || r.created.by.kind !== "human")) fail("STORE_INTEGRITY", "Generated artifact lacks behavioral closure");
  if (full) for (const [hash, size] of required) {
    const bytes = await requiredBlob(store, hash);
    if (size !== null && bytes.length !== size) fail("STORE_INTEGRITY", "Blob byte size mismatch");
  }
  return new Set(required.keys());
}
