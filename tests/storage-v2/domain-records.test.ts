import { afterEach, expect, test } from "bun:test";
import { fixture, snapshot, capabilityPolicy, declaration, fingerprint, backend } from "../domain-v2/fixtures";
import { baseBehavioralCatalog, syntheticCompatibility } from "../domain-v2/behavioral-fixtures";
import { builtinBundleManifestSchema } from "../../src/builtins/bundle";
import { recordSchemas, parseRecord, type DomainRecord } from "../../src/storage/records";
import { encodeRecord, decodeCanonical, canonicalBytes, hashCanonical } from "../../src/storage/file/canonical-json";
import { readRecords, recordBody } from "../../src/storage/file/records";
import { created, temporary, structured, code, mutation } from "./fixtures";
import { workspaceHandleSchema } from "../../src/workspace/schema";
import { withRun } from "./run-fixture";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
const f = fixture();
const codecRecords: DomainRecord[] = [f.spec, f.requirements, f.design, f.tasks, ...f.review.revisions, ...f.review.analyses,
  ...f.review.approvals, f.run, f.attempt, f.record, f.plan, f.plan.verifiers[0]!, f.tasks.tasks[0]!, f.state,
  snapshot(), capabilityPolicy(), declaration(), fingerprint(), backend(), f.workspace, ...baseBehavioralCatalog().assets.map((a) => a.revision)];
for (const [index, value] of codecRecords.entries()) test(`exact domain codec ${index}: ${value.schema}`, async () => {
  // Existing stage-03 fixtures use symbolic domain identities. This test verifies exact
  // codec fidelity, not fabricated historical body-hash validity or runtime provenance.
  const x = await temporary(); clean.push(x.cleanup);
  const encoded = encodeRecord(value); await x.store.blobs.put(encoded.bytes);
  expect((await readRecords(x.store.blobs, [encoded.reference]))[0]).toEqual(value);
  expect(canonicalBytes(parseRecord(decodeCanonical(encoded.bytes, "STORE_INTEGRITY")))).toEqual(encoded.bytes);
});
test("opaque provider JSON retains schema-looking and reference-looking data without interpreting it", async () => {
  const x = await created(); clean.push(x.cleanup);
  const value = workspaceHandleSchema.parse({ schema: "aira.dev/workspace-handle/v1", id: "workspace_opaque",
    provider: fingerprint().provider, project_identity: "project", location: "provider://opaque", isolation: "shared",
    provider_data: { nested: { schema: "aira.dev/vendor/v77", id: "profile_fake", revision: "rev_fake", hash: "not-a-storage-hash" } } });
  const encoded = encodeRecord(value), t = mutation(x.result);
  t.state.records.push(encoded.reference);
  const result = await x.store.commit(t, [{ hash: encoded.reference.hash, bytes: encoded.bytes }]);
  expect(result.records[0]).toEqual(value);
});
test("historical embedded policy revision cannot be rebound after selecting another revision", async () => {
  const x = await created(); clean.push(x.cleanup);
  const t = mutation(x.result); t.state.spec.decision_policy.waivable = ["unresolved-blocker"];
  t.state.spec.decision_policy.identity.revision = "rev_second" as never;
  let body = structured(recordBody(t.state.spec.decision_policy)); t.state.spec.decision_policy.identity.hash = body.hash;
  const next = await x.store.commit(t, [body]);
  const changed = mutation(next, "operation_rebind"); changed.state.spec.decision_policy.waivable = ["requirement-design-missing"];
  changed.state.spec.decision_policy.identity.revision = x.result.state.spec.decision_policy.identity.revision;
  body = structured(recordBody(changed.state.spec.decision_policy)); changed.state.spec.decision_policy.identity.hash = body.hash;
  await code(x.store.commit(changed, [body]), "STORE_INTEGRITY");
});
test("record format dispatch does not reinterpret unknown contracts or versions", () => {
  expect(Object.keys(recordSchemas).length).toBeGreaterThan(40);
  expect(() => parseRecord({ schema: "aira.dev/evidence/v99" })).toThrow();
  expect(() => parseRecord({ schema: "aira.dev/new-contract/v1" })).toThrow();
});
test("exact bundle attribution persists with measured member and bundle bytes", async () => {
  const x = await created(); clean.push(x.cleanup); const request = withRun(x.result);
  const assets = request.records.filter((r) => r.schema === "aira.dev/behavioral-asset/v1").map((r) => r.identity);
  const body = { schema: "aira.dev/builtin-bundle/v1", distribution_version: "synthetic-tests-only", compatibility: syntheticCompatibility,
    assets, defaults: [], spec_kinds: [], modes: [] };
  const manifest = builtinBundleManifestSchema.parse({ ...body, identity: { id: "bundle.aira.test", revision: "1", hash: hashCanonical(body) } });
  const encoded = encodeRecord(manifest); request.transaction.state.records.push(encoded.reference);
  request.blobs.push(structured(body), { hash: encoded.reference.hash, bytes: encoded.bytes });
  const pins = request.transaction.state.runs[0]!.snapshot.behavioral_assets.map((p) => ({ ...p, bundle: manifest.identity }));
  request.transaction.state.runs[0]!.snapshot.behavioral_assets = pins;
  request.transaction.state.spec.run_binding!.snapshot.behavioral_assets = pins;
  const result = await x.store.commit(request.transaction, request.blobs);
  expect(result.state.runs[0]!.snapshot.behavioral_assets.every((p) => p.bundle?.hash === manifest.identity.hash)).toBe(true);
  expect(result.records.at(-1)).toEqual(manifest);
  await x.store.verifySpecHistory(result.spec_id);
});
test("missing typed policy metadata is not replaced by an asserted pin/content hash", async () => {
  const x = await created(); clean.push(x.cleanup); const request = withRun(x.result);
  request.transaction.state.records = request.transaction.state.records.filter((r) => r.contract !== "aira.dev/capability-policy/v1");
  await code(x.store.commit(request.transaction, request.blobs), "STORE_INTEGRITY");
});
