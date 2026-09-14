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
import { identityRegistrySchema, stableIdentitySchema, validateIdentityChange, validateIdentityEvolution } from "../../spec/domain/ids";
import { validateRevisionResolution } from "../../revision/policy";
import { validateTaskGraph } from "../../tasks/graph";
import { planningContentContracts } from "../../spec/domain/planning-kinds";
import { planningEntities, validateFindingTargets, type PlanningDocument } from "../../spec/domain/planning-integrity";
import { validateArchitecture } from "../../spec/domain/architecture";
import { validateRequirementsProduct } from "../../spec/domain/requirements";
import { validateProgramDesign } from "../../spec/domain/program-design";
import { validateSliceReferences, validateTaskSliceConsistency } from "../../spec/domain/slices";

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
  if ("id" in record && ["aira.dev/artifact-revision/v2", "aira.dev/spec-approval/v2", "aira.dev/human-waiver/v2",
    "aira.dev/attempt/v2", "aira.dev/evidence/v2", "aira.dev/context-snapshot/v2", "aira.dev/revision-request/v2"].includes(record.schema))
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
    if (value.schema !== "aira.dev/task-definition/v2" && value.schema !== "aira.dev/verifier/v2") return;
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
function activeIdentities(state: StoreState, records: readonly DomainRecord[]) {
  const revisions = new Set([...state.spec.artifacts.current.map((s) => s.artifact.revision), ...state.spec.analyses.map((a) => a.revision)]);
  return records.flatMap((r) => {
    if (!("revision" in r) || !revisions.has(r.revision)) return [];
    if (r.schema === "aira.dev/analysis/v2") return r.findings.map((f) => stableIdentitySchema.parse(f.id));
    if (Object.values(planningContentContracts).includes(r.schema as never) && r.schema !== "aira.dev/intent/v1")
      return planningEntities(r as PlanningDocument).map((e) => stableIdentitySchema.parse(e.id));
    return [];
  });
}
export function checkRecordEvolution(previous: readonly DomainRecord[], next: readonly DomainRecord[], before: StoreState, after: StoreState): void {
  validateReferenceIdentities([before, after, ...previous, ...next]);
  const identities = validateIdentityEvolution(identityRegistrySchema.parse(before.spec.identities), identityRegistrySchema.parse(after.spec.identities));
  if (identities.length) fail("STORE_INTEGRITY", `Identity registry changed: ${JSON.stringify(identities)}`);
  const changes = validateIdentityChange(identityRegistrySchema.parse(before.spec.identities), identityRegistrySchema.parse(after.spec.identities),
    activeIdentities(before, previous), activeIdentities(after, next));
  if (changes.length) fail("STORE_INTEGRITY", `Stable identity evolution invalid: ${JSON.stringify(changes)}`);
  for (const old of previous) {
    const key = logicalRecordKey(old);
    const current = key ? next.find((r) => logicalRecordKey(r) === key) : next.find((r) => exact(r, old));
    if (!current) fail("STORE_INTEGRITY", "Authoritative historical record was removed");
    if (exact(old, current)) continue;
    // The domain's revision request is a state machine, not an immutable decision.
    // Preserve exact initial feedback/provenance and only publish its first terminal resolution.
    if (old.schema === "aira.dev/revision-request/v2" && current.schema === old.schema && old.status === "pending" && current.status !== "pending") {
      const { status: _, ...oldBase } = old;
      if (Object.entries(oldBase).every(([k, v]) => exact(v, (current as unknown as Record<string, unknown>)[k]))) {
        if (current.status === "resolved") {
          const artifact = next.find((r) => r.schema === "aira.dev/artifact-revision/v2" && exact(referenceOf(r), current.resolution.resulting_artifact));
          if (!artifact || artifact.schema !== "aira.dev/artifact-revision/v2" || validateRevisionResolution(old, current.resolution, artifact).length)
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
    const execution = ["aira.dev/attempt/v2", "aira.dev/evidence/v2", "aira.dev/reconciliation/v1"].includes(record.schema) ||
      (record.schema === "aira.dev/context-snapshot/v2" && ["implementation", "verification"].includes(record.phase));
    if (execution ? exact(before.runs, after.runs) : before.spec.generation === after.spec.generation)
      fail("STORE_CONFLICT", "Record mutation requires its scoped domain generation");
  }
}

/** Current closure, never the global blob directory or history. Full mode also checks
 * raw artifact/context/evidence/asset bytes. Structured records are always verified.
 */
export async function validateState(store: BlobStore, state: StoreState, records: readonly DomainRecord[], full: boolean): Promise<Set<ContentHash>> {
  validateReferenceIdentities([state, ...records]);
  const registry = identityRegistrySchema.parse(state.spec.identities), active = activeIdentities(state, records);
  if (validateIdentityChange(registry, registry, active, active).length) fail("STORE_INTEGRITY", "Current planning identity unregistered or retired");
  const required = new Map<ContentHash, number | null>();
  const add = (hash: ContentHash, size: number | null = null): void => {
    const prior = required.get(hash);
    if (prior !== undefined && prior !== null && size !== null && prior !== size) fail("STORE_INTEGRITY", "Conflicting byte sizes for blob");
    required.set(hash, size ?? prior ?? null);
  };
  for (const ref of state.records) add(ref.hash);
  const revisions = records.filter((r) => r.schema === "aira.dev/artifact-revision/v2");
  const analyses = records.filter((r) => r.schema === "aira.dev/analysis/v2");
  for (const entry of state.spec.identities.entries) if (!revisions.some((r) => r.id === entry.introduced_in) ||
    (entry.retired_in && !revisions.some((r) => r.id === entry.retired_in))) fail("STORE_INTEGRITY", "Identity registry lacks introduction/retirement revision");
  const snapshots = records.filter((r) => r.schema === "aira.dev/behavioral-profile-snapshot/v2");
  const assets = records.filter((r) => r.schema === "aira.dev/behavioral-asset/v1");
  const bundles = records.filter((r) => r.schema === "aira.dev/builtin-bundle/v2");
  const pins: BehavioralAssetPin[] = [];
  const definitions = nestedImmutable(records);
  const values = [state.spec, ...state.runs, ...records, ...state.blobs];
  const has = (schema: DomainRecord["schema"], id: string): boolean => records.some((r) => r.schema === schema && "id" in r && r.id === id);
  if (state.spec.approvals.some((id) => !has("aira.dev/spec-approval/v2", id)) || state.spec.waivers.some((id) => !has("aira.dev/human-waiver/v2", id)) ||
    state.spec.revisions.some((id) => !has("aira.dev/revision-request/v2", id))) fail("STORE_INTEGRITY", "Missing human decision/revision record");
  const attempts = records.filter((r) => r.schema === "aira.dev/attempt/v2");
  const evidence = records.filter((r) => r.schema === "aira.dev/evidence/v2");
  for (const run of state.runs) {
    for (const id of run.attempts) {
      const attempt = attempts.find((a) => a.id === id);
      if (!attempt || attempt.run !== run.id || !exact(attempt.snapshot, run.snapshot) || BigInt(attempt.run_generation) > BigInt(run.generation))
        fail("STORE_INTEGRITY", "Run attempt has missing or mismatched immutable inputs");
    }
    for (const selected of run.current_evidence) {
      const item = evidence.find((e) => e.id === selected.evidence);
      if (!item || !exact(item.task, selected.task) || item.verifier.id !== selected.verifier ||
        !run.attempts.includes(item.attempt) || !exact(item.snapshot, run.snapshot))
        fail("STORE_INTEGRITY", "Selected evidence does not belong to this run/task/verifier");
    }
    for (const claim of run.claims) if (!exact(claim.snapshot, run.snapshot)) fail("STORE_INTEGRITY", "Claim snapshot differs from its run");
    for (const task of run.tasks) if (task.claim && !run.claims.some((c) => c.id === task.claim && exact(c.task, task.task) && c.attempt === task.current_attempt))
      fail("STORE_INTEGRITY", "Task refers to a missing or unrelated claim");
    for (const authority of run.authorities) if (!exact(authority.snapshot, run.snapshot) ||
      !attempts.some((a) => a.id === authority.attempt && exact(a.fence, authority.fence)))
      fail("STORE_INTEGRITY", "Authority does not bind its exact attempt");
  }
  for (const attempt of attempts) if (!state.runs.some((r) => r.id === attempt.run && r.attempts.includes(attempt.id)))
    fail("STORE_INTEGRITY", "Attempt lacks its owning run");
  for (const item of evidence) {
    const attempt = attempts.find((a) => a.id === item.attempt);
    if (!attempt || !exact(item.task, attempt.task) || !exact(item.snapshot, attempt.snapshot))
      fail("STORE_INTEGRITY", "Evidence lacks its exact attempt/task/snapshot");
  }
  for (const record of records) {
    if ("spec_id" in record && record.spec_id !== state.spec.id) fail("STORE_INTEGRITY", "Cross-Spec structured record");
    if (record.schema === "aira.dev/spec/v2" || record.schema === "aira.dev/execution-run/v2") fail("STORE_INTEGRITY", "Spec/run snapshots belong in the authoritative state, not its record catalog");
    // Canonical identity-bearing structured bodies and raw asset bytes have different subjects.
    if ("identity" in record && typeof record.identity === "object" && record.identity && "hash" in record.identity) {
      const hash = record.identity.hash as ContentHash;
      if (record.schema !== "aira.dev/behavioral-asset/v1") {
        if (hashCanonical(recordBody(record)) !== hash) fail("STORE_INTEGRITY", "Structured self-identity body mismatch");
      }
      add(hash);
    }
    if (record.schema === "aira.dev/spec-kind-profile/v2" || record.schema === "aira.dev/mode-profile/v2") {
      if (hashCanonical(recordBody(record)) !== record.asset.hash) fail("STORE_INTEGRITY", "Behavioral configuration does not describe its bytes");
      add(record.asset.hash);
    }
    if (record.schema === "aira.dev/context-snapshot/v2") for (const entry of record.entries) {
      add(entry.content_hash, entry.byte_size); if (entry.source) add(entry.source.original_hash);
    }
    if (record.schema === "aira.dev/artifact-revision/v2") {
      const expected = planningContentContracts[record.kind];
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
    if (object.schema === "aira.dev/spec-decision-policy/v2" || object.schema === "aira.dev/spec-completion-policy/v2" ||
      object.schema === "aira.dev/task-definition/v2" || object.schema === "aira.dev/verifier/v2") {
      const definition = parseRecord(object);
      if (!("identity" in definition) || !("hash" in definition.identity) || hashCanonical(recordBody(definition)) !== definition.identity.hash)
        fail("STORE_INTEGRITY", "Nested definition content hash mismatch");
    }
    if (typeof object.id === "string" && /^[TV][1-9][0-9]*$/.test(object.id) && typeof object.revision === "string" && typeof object.hash === "string") {
      const schema = object.id.startsWith("T") ? "aira.dev/task-definition/v2" : "aira.dev/verifier/v2";
      const definition = definitions.get(`${schema}:${object.id}:${object.revision}`) as { identity: unknown } | undefined;
      if (!definition || !exact(definition.identity, object)) fail("STORE_INTEGRITY", "Unknown exact task/verifier definition");
    }
    if (object.schema === "aira.dev/approved-spec-snapshot/v2" && (object.approvals as string[]).some((id) => !has("aira.dev/spec-approval/v2", id)))
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
      const index = state.records.findIndex((r) => r.hash === object.hash && r.contract === "aira.dev/context-snapshot/v2");
      const target = records[index];
      if (!target || target.schema !== "aira.dev/context-snapshot/v2" || target.id !== object.id) fail("STORE_INTEGRITY", "Missing exact context snapshot");
    }
  });
  for (const document of records.filter((r) => r.schema === "aira.dev/tasks/v2")) {
    const contexts = document.tasks.flatMap((t) => t.context.references).filter((ref) => {
      const index = state.records.findIndex((r) => r.contract === "aira.dev/context-declaration/v2" && r.hash === ref.hash);
      const record = records[index];
      return record?.schema === "aira.dev/context-declaration/v2" && record.id === ref.id;
    });
    const graphIssues = validateTaskGraph(document, {
      requirements: records.flatMap((r) => r.schema === "aira.dev/requirements/v2" ? r.requirements : []),
      decisions: records.flatMap((r) => r.schema === "aira.dev/architecture/v1" ? r.decisions : []),
      program_decisions: records.flatMap((r) => r.schema === "aira.dev/program-design/v1" ? r.decisions : []),
      verifiers: [...definitions.values()].flatMap((r) => {
        const record = r as DomainRecord;
        return record.schema === "aira.dev/verifier/v2" ? [record.identity] : [];
      }),
      policies: records.flatMap((r) => r.schema === "aira.dev/capability-policy/v1" ? [r.identity] : []),
      execution_profiles: records.flatMap((r) => r.schema === "aira.dev/execution-profile/v1" ? [r.identity] : []), contexts,
    });
    if (graphIssues.length) fail("STORE_INTEGRITY", `Task reference closure invalid: ${JSON.stringify(graphIssues)}`);
  }
  const planning = records.filter((r): r is PlanningDocument => ["aira.dev/product/v1", "aira.dev/requirements/v2", "aira.dev/architecture/v1",
    "aira.dev/program-design/v1", "aira.dev/slice-plan/v1", "aira.dev/tasks/v2", "aira.dev/verification-plan/v2"].includes(r.schema));
  const entities = planning.map((document) => {
    const revision = revisions.find((r) => r.id === document.revision);
    if (!revision) fail("STORE_INTEGRITY", "Planning document lacks its immutable artifact envelope");
    return { artifact: referenceOf(revision), entities: planningEntities(document).map((e) => ({ id: e.id, hash: hashCanonical(e.value) })) };
  });
  // Resolve reference catalogs through exact provenance, not all historical entities with the same ID.
  function upstream<S extends PlanningDocument["schema"]>(revision: string, schema: S): Extract<PlanningDocument, { schema: S }> | undefined {
    let layer = [revision]; const seen = new Set<string>();
    while (layer.length) {
      const matches = planning.filter((p) => layer.includes(p.revision) && p.schema === schema);
      if (matches.length > 1) fail("STORE_INTEGRITY", "Ambiguous exact planning input");
      if (matches.length === 1) return matches[0] as Extract<PlanningDocument, { schema: S }>;
      const next: string[] = [];
      for (const id of layer) {
        if (seen.has(id)) continue; seen.add(id);
        const r = revisions.find((r) => r.id === id);
        next.push(...(r?.lineage.filter((e) => e.relation !== "supersedes" && e.target.kind !== r.kind).map((e) => e.target.revision) ?? []));
      }
      layer = [...new Set(next)].filter((id) => !seen.has(id));
    }
    return undefined;
  }
  for (const document of planning) {
    const product = upstream(document.revision, "aira.dev/product/v1"), req = upstream(document.revision, "aira.dev/requirements/v2"),
      arch = upstream(document.revision, "aira.dev/architecture/v1"), program = upstream(document.revision, "aira.dev/program-design/v1"),
      slices = upstream(document.revision, "aira.dev/slice-plan/v1");
    const defects: import("../../spec/domain/primitives").DomainIssue[] = [];
    if (document.schema === "aira.dev/requirements/v2") {
      if (product) defects.push(...validateRequirementsProduct(document, product).filter((i) => i.code !== "requirement-product-coverage-missing"));
      else if (document.requirements.some((r) => r.product_outcomes.length || r.success_criteria.length)) defects.push({ code: "requirements-product-input-missing" });
    }
    if (document.schema === "aira.dev/architecture/v1") {
      const validation = state.spec.lineage.validations.find((v) => v.subject.revision === document.revision);
      const against = planning.find((p) => p.schema === "aira.dev/requirements/v2" && validation?.against.some((a) => a.revision === p.revision));
      defects.push(...validateArchitecture(document, req ?? (against?.schema === "aira.dev/requirements/v2" ? against : undefined)));
    }
    if (document.schema === "aira.dev/program-design/v1") {
      if (!arch || !req) defects.push({ code: "program-design-input-missing" });
      else defects.push(...validateProgramDesign(document, arch, req));
    }
    if (document.schema === "aira.dev/slice-plan/v1") {
      if (!product || !req || !arch || !program) defects.push({ code: "slice-plan-input-missing" });
      else {
        const verification = planning.find((p) => p.schema === "aira.dev/verification-plan/v2" &&
          upstream(p.revision, "aira.dev/slice-plan/v1")?.revision === document.revision);
        defects.push(...validateSliceReferences(document, product, req, arch, program, verification?.schema === "aira.dev/verification-plan/v2" ? verification : undefined));
      }
    }
    if (document.schema === "aira.dev/verification-plan/v2") {
      const tasks = upstream(document.revision, "aira.dev/tasks/v2");
      if (!slices || !req || !tasks) defects.push({ code: "verification-planning-input-missing" });
      else for (const verifier of document.verifiers) {
        if (verifier.slices.some((id) => !slices.slices.some((s) => s.id === id)) ||
          verifier.tasks.some((id) => !tasks.tasks.some((t) => t.identity.id === id && t.verifiers.includes(verifier.identity.id))) ||
          verifier.requirements.some((id) => !req.requirements.some((r) => r.id === id)) ||
          verifier.acceptance_criteria.some((id) => !req.requirements.some((r) => r.acceptance_criteria.some((a) => a.id === id)))) defects.push({ code: "verifier-exact-planning-reference-missing", verifier: verifier.identity.id });
      }
    }
    if (document.schema === "aira.dev/tasks/v2") {
      if (!slices || !arch || !program || !req) defects.push({ code: "task-planning-input-missing" });
      else {
        defects.push(...validateTaskSliceConsistency(slices, document));
        for (const t of document.tasks) {
          if (t.architecture_decisions.some((id) => !arch.decisions.some((d) => d.id === id)) ||
            t.program_design_decisions.some((id) => !program.decisions.some((d) => d.id === id)) ||
            t.requirements.some((id) => !req.requirements.some((r) => r.id === id)) ||
            t.acceptance_criteria.some((id) => !req.requirements.some((r) => r.acceptance_criteria.some((a) => a.id === id)))) defects.push({ code: "task-exact-planning-reference-missing", task: t.identity.id });
        }
      }
    }
    if (defects.length) fail("STORE_INTEGRITY", `Planning reference closure invalid: ${JSON.stringify(defects)}`);
  }
  const targetIssues = validateFindingTargets(analyses, planning);
  if (targetIssues.length) fail("STORE_INTEGRITY", `Finding target invalid: ${JSON.stringify(targetIssues)}`);
  for (const run of state.runs) for (const slice of run.slices) {
    const plan = planning.find((p) => p.schema === "aira.dev/slice-plan/v1" && p.revision === slice.plan.revision);
    if (!plan || plan.schema !== "aira.dev/slice-plan/v1" || !plan.slices.some((s) => s.id === slice.slice) ||
      !run.snapshot.artifacts.some((s) => exact(s.artifact, slice.plan))) fail("STORE_INTEGRITY", "Unknown run slice definition");
    for (const selected of slice.current_evidence) if (!evidence.some((e) => e.id === selected.evidence && e.verifier.id === selected.verifier &&
      e.slices.includes(slice.slice) && exact(e.snapshot, run.snapshot) && run.attempts.includes(e.attempt))) fail("STORE_INTEGRITY", "Slice evidence binding mismatch");
  }
  // Intrinsic lineage closure/cycles are storage integrity; approval/readiness/completion remain Core decisions.
  const issues = currentLineageValidity({ entities, revisions, validations: state.spec.lineage.validations,
    current: [...state.spec.artifacts.current.map((s) => s.artifact), ...state.spec.analyses], proposed: state.spec.artifacts.proposed,
    invalidations: state.spec.lineage.invalidations, analyses, generation: state.spec.generation });
  if (issues.length) fail("STORE_INTEGRITY", `Invalid lineage: ${JSON.stringify(issues)}`);
  if (pins.length || snapshots.length) {
    if (!state.behavioral_environment) fail("STORE_INTEGRITY", "Pinned assets require an explicit compatibility environment");
    const catalog: BehavioralAssetCatalog = {
      assets: assets.map((revision) => {
        const configuration = records.find((r) => (r.schema === "aira.dev/spec-kind-profile/v2" || r.schema === "aira.dev/mode-profile/v2") && exact(r.asset, revision.identity));
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
