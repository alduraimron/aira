import { mkdtemp, rm, realpath, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transactionSchema, type BlobInput, type StoreSnapshot, type StoreTransaction } from "../../src/storage/types";
import { canonicalBytes, encodeRecord, hashBytes, hashCanonical } from "../../src/storage/file/canonical-json";
import { specSchema } from "../../src/spec/domain/schema";
import { artifactRevisionSchema, referenceOf } from "../../src/spec/domain/artifacts";
import { requirementsSchema } from "../../src/spec/domain/requirements";
import { artifactLineageHash } from "../../src/storage/file/records";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import type { FileStoreOptions } from "../../src/storage/file/fsync";
import { expect } from "bun:test";
import type { StorageErrorCode } from "../../src/storage/errors";

export const at = "2026-08-26T12:00:00.000Z";
export const human = { kind: "human", id: "local" } as const;
export const metadata = { at, by: human, operation: "operation_author", channel: "cli" } as const;
export const raw = (value: string): BlobInput => { const bytes = new TextEncoder().encode(value); return { hash: hashBytes(bytes), bytes }; };
export const structured = (value: unknown): BlobInput => { const bytes = canonicalBytes(value); return { hash: hashBytes(bytes), bytes }; };
export function creation(id = "spec_one", operation = "operation_create") {
  const decision = { schema: "aira.dev/spec-decision-policy/v1", waivable: [], required_analyses: ["requirements", "design", "tasks"] };
  const completion = { schema: "aira.dev/spec-completion-policy/v1", traceability: "must", allow_agent_review: false,
    final_consistency_review_required: false, verification_plan_approval_required: false };
  const blobs = [structured(decision), structured(completion)];
  const spec = specSchema.parse({ schema: "aira.dev/spec/v1", id, title: "Persistence test", kind: "feature",
    mode: "requirements-first", authoring_order: "requirements-first", lifecycle: { state: "draft" }, generation: "0",
    artifacts: { current: [], proposed: [], superseded: [] }, analyses: [], behavioral_selections: [], behavioral_profiles: [],
    lineage: { validations: [], invalidations: [] }, approvals: [], approval_applicability: [], revisions: [], waivers: [], waiver_applicability: [],
    identities: { schema: "aira.dev/identity-registry/v1", entries: [] },
    decision_policy: { ...decision, identity: { id: "policy_decision", revision: "rev_decision", hash: blobs[0]!.hash } },
    completion_policy: { ...completion, identity: { id: "policy_completion", revision: "rev_completion", hash: blobs[1]!.hash } },
    created: metadata, updated_at: at, metadata: { labels: [], external_references: [] } });
  const transaction = transactionSchema.parse({ schema: "aira.dev/store-transaction/v1", spec_id: id, operation,
    expected: null, mutation: { kind: "create", spec: true, runs: [], reason: "Create Spec" }, actor: human, channel: "api",
    state: { schema: "aira.dev/store-state/v1", spec, runs: [], records: [], blobs: [], behavioral_environment: null },
    events: [{ kind: "spec-created", identities: [id], payloads: [] }] });
  return { transaction, blobs };
}
export function mutation(snapshot: StoreSnapshot, operation = "operation_edit", title = snapshot.state.spec.title === "Updated title" ? "Updated title again" : "Updated title", audit = false) {
  return transactionSchema.parse({ schema: "aira.dev/store-transaction/v1", spec_id: snapshot.head.spec_id, operation,
    expected: { head: snapshot.head, current_artifacts: snapshot.state.spec.artifacts.current, execution: [] },
    mutation: { kind: audit ? "audit" : "spec", spec: !audit, runs: [], reason: audit ? "Record audit" : "Edit title" }, actor: human,
    state: { ...snapshot.state, spec: audit ? snapshot.state.spec : { ...snapshot.state.spec, title, generation: (BigInt(snapshot.head.spec_generation) + 1n).toString() } },
    events: [{ kind: audit ? "inspected" : "title-changed", identities: [snapshot.head.spec_id], payloads: [] }] });
}
export function withRequirements(input: StoreTransaction) {
  const document = requirementsSchema.parse({ schema: "aira.dev/requirements/v1", spec_id: input.spec_id, revision: "rev_requirements",
    requirements: [{ id: "R1", type: "functional", title: "Atomic storage", priority: "must", statement: "Publication is atomic", dependencies: [],
      rationale: "No partial state", assumptions: ["local filesystem"], acceptance_criteria: [{ id: "R1.AC1", form: "ubiquitous", expected_behavior: "Readers see old or new" }] }] });
  const body = encodeRecord(document);
  const revision = artifactRevisionSchema.parse({ schema: "aira.dev/artifact-revision/v1", id: document.revision, spec_id: input.spec_id, kind: "requirements",
    content: { hash: body.reference.hash, bytes: body.bytes.length, media_type: "application/json" }, lineage: [], created: metadata });
  const envelope = encodeRecord(revision);
  const transaction = transactionSchema.parse({ ...input, state: { ...input.state,
    spec: { ...input.state.spec, artifacts: { ...input.state.spec.artifacts, current: [{ artifact: referenceOf(revision), lineage_hash: artifactLineageHash(revision) }] },
      identities: { schema: "aira.dev/identity-registry/v1", entries: [{ id: "R1", introduced_in: document.revision }, { id: "R1.AC1", introduced_in: document.revision }] } },
    records: [...input.state.records, body.reference, envelope.reference] } });
  return { transaction, document, revision, blobs: [body, envelope].map((r) => ({ hash: r.reference.hash, bytes: r.bytes })) };
}
export async function temporary(options: FileStoreOptions = {}) {
  // /tmp is often tmpfs, which the production backend correctly refuses. Do not
  // disable durability for tests: use a persistent local temporary directory.
  const temporaryRoot = process.platform === "linux" && [0x01021994, 0x858458f6].includes((await statfs(tmpdir())).type >>> 0) ? "/var/tmp" : tmpdir();
  const root = await mkdtemp(join(await realpath(temporaryRoot), "aira-store-v2-"));
  return { root, store: new FileSpecStore(root, { clock: () => at, ...options }), cleanup: () => rm(root, { recursive: true, force: true }) };
}
export async function created(options: FileStoreOptions = {}) {
  const context = await temporary(options), request = creation();
  const result = await context.store.createSpec(request.transaction, request.blobs);
  return { ...context, request, result };
}
export async function code(promise: Promise<unknown>, expected: StorageErrorCode) {
  await expect(promise).rejects.toMatchObject({ code: expected });
}
export { hashCanonical };
