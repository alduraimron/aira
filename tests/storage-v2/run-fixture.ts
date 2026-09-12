import { fixture, task, capabilityPolicy } from "../domain-v2/fixtures";
import { baseBehavioralPins, syntheticCompatibility, syntheticEnvironment } from "../domain-v2/behavioral-fixtures";
import { behavioralAssetRevisionSchema } from "../../src/builtins/assets";
import { artifactRevisionSchema, approvedSpecSnapshotSchema, referenceOf } from "../../src/spec/domain/artifacts";
import { executionRunSchema, executionProfileSchema } from "../../src/execution/schema";
import { specApprovalRecordSchema } from "../../src/approval/spec-records";
import { tasksSchema, taskDefinitionSchema } from "../../src/tasks/schema";
import { transactionSchema, type BlobInput, type StoreSnapshot } from "../../src/storage/types";
import { encodeRecord, hashCanonical } from "../../src/storage/file/canonical-json";
import { artifactLineageHash, recordBody } from "../../src/storage/file/records";
import { mutation, metadata, raw, structured, at } from "./fixtures";
import type { DomainRecord } from "../../src/storage/records";

/** Actual measured synthetic bytes. No production prompt/skill content. */
export function withRun(snapshot: StoreSnapshot) {
  const t = mutation(snapshot, "operation_start_run"), blobs: BlobInput[] = [], records: DomainRecord[] = [];
  const pins = baseBehavioralPins().map((pin) => {
    const content = raw(`\0synthetic binary asset ${pin.role}\xff`); blobs.push(content);
    const asset = { ...pin.asset, hash: content.hash };
    if ("profile" in asset) {
      if (asset.kind === "execution-profile") {
        const recipe = raw("synthetic recipe bytes"); blobs.push(recipe);
        const profile = executionProfileSchema.parse({ schema: "aira.dev/execution-profile/v1", identity: asset.profile,
          recipe: { id: "profile_recipe", revision: "rev_recipe", hash: recipe.hash }, context: [], recovery: [],
          retry: { schema: "aira.dev/retry-policy/v1", automatic: false, max_attempts: 1, outcomes: [] } });
        const body = structured(recordBody(profile)); profile.identity.hash = body.hash;
        records.push(profile); blobs.push(body); asset.profile = profile.identity;
      } else {
        const body = raw(`synthetic opaque profile ${asset.profile.id}`); blobs.push(body); asset.profile = { ...asset.profile, hash: body.hash };
      }
    }
    if ("policy" in asset) {
      const policy = capabilityPolicy(); policy.process = { mode: "deny" };
      const body = structured(recordBody(policy)); policy.identity.hash = body.hash;
      records.push(policy); blobs.push(body); asset.policy = policy.identity;
    }
    records.push(behavioralAssetRevisionSchema.parse({ schema: "aira.dev/behavioral-asset/v1", identity: asset,
      content_encoding: "aira.dev/asset-bytes/raw/v1", compatibility: syntheticCompatibility,
      metadata: { title: "Synthetic", description: "Storage test bytes", labels: [], published: metadata } }));
    return { role: pin.role, asset };
  });
  const policy = pins.find((p) => "policy" in p.asset)!.asset;
  const execute = pins.find((p) => p.role === "execution-profile")!.asset;
  const verify = pins.find((p) => p.role === "verification-profile")!.asset;
  if (!("policy" in policy) || !("profile" in execute) || !("profile" in verify)) throw Error("fixture pin shape");
  const base = fixture(), revisions: ReturnType<typeof artifactRevisionSchema.parse>[] = [];
  function artifact(document: DomainRecord, kind: "requirements" | "design" | "tasks") {
    if (!("revision" in document)) throw Error("fixture revision missing");
    const blob = encodeRecord(document);
    const revision = artifactRevisionSchema.parse({ schema: "aira.dev/artifact-revision/v1", id: document.revision, spec_id: snapshot.head.spec_id, kind,
      content: { hash: blob.reference.hash, bytes: blob.bytes.length, media_type: "application/json" }, created: metadata,
      lineage: revisions.map((r) => ({ relation: "derived_from", target: referenceOf(r) })) });
    revisions.push(revision); records.push(document, revision); return revision;
  }
  const req = artifact(base.requirements, "requirements"); artifact(base.design, "design");
  const definition = taskDefinitionSchema.parse({ ...task(), capability_policy: policy.policy, execution_profile: execute.profile,
    completion: [{ kind: "artifact-published", artifact: referenceOf(req) }], verifiers: [], context: { declarations: [], references: [] } });
  definition.identity.hash = hashCanonical(recordBody(definition)); blobs.push(structured(recordBody(definition)));
  artifact(tasksSchema.parse({ ...base.tasks, tasks: [definition] }), "tasks");
  const subjects = revisions.map((r) => ({ artifact: referenceOf(r), lineage_hash: artifactLineageHash(r) }));
  const approval = specApprovalRecordSchema.parse({ schema: "aira.dev/spec-approval/v1", id: "approval_run", spec_id: snapshot.head.spec_id,
    operation: t.operation, actor: metadata.by, observed_generation: "0", committed_generation: "1", subjects, decision: "approved", scope: "integrated", integrated_group: t.operation, at });
  records.push(approval);
  const approved = approvedSpecSnapshotSchema.parse({ schema: "aira.dev/approved-spec-snapshot/v1", spec_id: snapshot.head.spec_id, generation: "1", artifacts: subjects,
    approvals: [approval.id], decision_policy: t.state.spec.decision_policy.identity, completion_policy: t.state.spec.completion_policy.identity,
    verification_profile: verify.profile, capability_policies: [policy.policy], behavioral_profiles: [], behavioral_assets: pins });
  const run = executionRunSchema.parse({ schema: "aira.dev/execution-run/v1", id: "run_one", commit_sequence: "2", generation: "0", snapshot: approved,
    status: "pending", scheduling: { max_parallel: 1, ordering: "priority-then-task-id-codepoint" }, tasks: [], claims: [], attempts: [], authorities: [],
    current_evidence: [], created_at: at, updated_at: at });
  const encoded = records.map(encodeRecord); blobs.push(...encoded.map((r) => ({ hash: r.reference.hash, bytes: r.bytes })));
  const transaction = transactionSchema.parse({ ...t, mutation: { ...t.mutation, kind: "spec-and-run", runs: [run.id] }, state: {
    ...t.state, runs: [run], records: encoded.map((r) => r.reference), behavioral_environment: syntheticEnvironment(),
    spec: { ...t.state.spec, mode: "quick", artifacts: { current: subjects, proposed: [], superseded: [] }, approvals: [approval.id],
      run_binding: { run: run.id, snapshot: approved, applicable_generation: "1", status: "applicable" } },
  } });
  return { transaction, blobs, records, run };
}
