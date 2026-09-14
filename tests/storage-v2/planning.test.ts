import { afterEach, expect, test } from "bun:test";
import { created, code, structured } from "./fixtures";
import { withRun } from "./run-fixture";
import { planningKinds, planningContentContracts } from "../../src/spec/domain/planning-kinds";
import { parseRecord, type DomainRecord } from "../../src/storage/records";
import { hashCanonical, encodeRecord } from "../../src/storage/file/canonical-json";
import { recordBody } from "../../src/storage/file/records";
import { sliceExecutionStateSchema } from "../../src/spec/domain/slice-state";
import { fixture } from "../domain-v2/fixtures";
import { programDesignSchema } from "../../src/spec/domain/program-design";
import { architectureSchema } from "../../src/spec/domain/architecture";
import { requirementsSchema } from "../../src/spec/domain/requirements";
import { slicePlanSchema } from "../../src/spec/domain/slices";
import { tasksSchema } from "../../src/tasks/schema";
import { verificationPlanSchema } from "../../src/verification/schema";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
test("expanded six-artifact state and exact Slice run binding round-trip through HEAD", async () => {
  const x = await created(); clean.push(x.cleanup); const request = withRun(x.result);
  const run = request.transaction.state.runs[0]!, plan = run.snapshot.artifacts.find((s) => s.artifact.kind === "slice-plan")!.artifact;
  run.slices.push(sliceExecutionStateSchema.parse({ schema: "aira.dev/slice-state/v1", slice: "S1", plan, run: run.id,
    run_generation: "0", status: "pending", current_evidence: [], updated_at: run.updated_at }));
  const saved = await x.store.commit(request.transaction, request.blobs), loaded = await x.store.loadSpec(saved.spec_id, "deep");
  expect(loaded.state).toEqual(saved.state);
  for (const kind of planningKinds) {
    const subject = loaded.state.spec.artifacts.current.find((s) => s.artifact.kind === kind)!;
    const document = loaded.records.find((r) => r.schema === planningContentContracts[kind])!;
    expect(subject.artifact.hash).toBe(hashCanonical(document));
    expect(document).toEqual(request.records.find((r) => r.schema === document.schema)!);
  }
  expect(loaded.state.runs[0]!.slices[0]!.plan).toEqual(plan);
  expect(loaded.state.spec.identities.entries.map((e) => String(e.id))).toEqual(expect.arrayContaining(["O1", "SC1", "A1", "PD1", "S1", "R1", "R1.AC1", "T1", "V1"]));
});

const corruptions: [string, (r: DomainRecord) => DomainRecord][] = [
  ["Requirement Product reference", (r) => r.schema === "aira.dev/requirements/v2" ? requirementsSchema.parse({ ...r, requirements: r.requirements.map((q) => ({ ...q, product_outcomes: ["O99"] })) }) : r],
  ["Requirement success reference", (r) => r.schema === "aira.dev/requirements/v2" ? requirementsSchema.parse({ ...r, requirements: r.requirements.map((q) => ({ ...q, success_criteria: ["SC99"] })) }) : r],
  ["Architecture Requirement reference", (r) => r.schema === "aira.dev/architecture/v1" ? architectureSchema.parse({ ...r, decisions: r.decisions.map((d) => ({ ...d, requirements: ["R99"], acceptance_criteria: [] })) }) : r],
  ["Program Architecture reference", (r) => r.schema === "aira.dev/program-design/v1" ? programDesignSchema.parse({ ...r, decisions: r.decisions.map((d) => ({ ...d, architecture_decisions: ["A99"] })) }) : r],
  ["Program symbol reference", (r) => r.schema === "aira.dev/program-design/v1" ? programDesignSchema.parse({ ...r, call_paths: [{ entry: "GET /export", symbols: ["unknownSymbol"], result: "CSV" }] }) : r],
  ["Slice Program reference", (r) => r.schema === "aira.dev/slice-plan/v1" ? slicePlanSchema.parse({ ...r, slices: r.slices.map((s) => ({ ...s, program_design_decisions: ["PD99"] })) }) : r],
  ["Slice verifier reference", (r) => r.schema === "aira.dev/slice-plan/v1" ? slicePlanSchema.parse({ ...r, slices: r.slices.map((s) => ({ ...s, required_verifiers: ["V99"], completion: [{ id: "test", predicate: "CSV complete", verifier: "V99" }] })) }) : r],
  ["Verifier Slice reference", (r) => r.schema === "aira.dev/verification-plan/v2" ? verificationPlanSchema.parse({ ...r, verifiers: r.verifiers.map((v) => ({ ...v, slices: ["S1", "S99"] })) }) : r],
  ["Task Slice ownership", (r) => r.schema === "aira.dev/tasks/v2" ? tasksSchema.parse({ ...r, tasks: r.tasks.map((t) => ({ ...t, slice: "S99" })) }) : r],
];
for (const [name, alter] of corruptions) test(`correctly rehashed ${name} corruption fails planning integrity without advancing HEAD`, async () => {
  const x = await created(); clean.push(x.cleanup); const nested: ReturnType<typeof structured>[] = [];
  const request = withRun(x.result, (r) => {
    const changed = alter(r);
    if (changed.schema === "aira.dev/verification-plan/v2") {
      const plan = verificationPlanSchema.parse(changed);
      for (const verifier of plan.verifiers) { const body = structured(recordBody(verifier)); verifier.identity.hash = body.hash; nested.push(body); }
      return plan;
    }
    if (changed.schema !== "aira.dev/tasks/v2") return changed;
    // Rehash nested definitions too: this must fail reference semantics, not a checksum shortcut.
    const tasks = tasksSchema.parse(changed);
    for (const task of tasks.tasks) { const body = structured(recordBody(task)); task.identity.hash = body.hash; nested.push(body); }
    return tasks;
  });
  request.blobs.push(...nested);
  await code(x.store.commit(request.transaction, request.blobs), "STORE_INTEGRITY");
  expect(await x.store.inspectHead(x.result.spec_id)).toEqual(x.result.head);
});
test("unknown exact Slice state reference cannot borrow an existing run snapshot", async () => {
  const x = await created(); clean.push(x.cleanup); const request = withRun(x.result), run = request.transaction.state.runs[0]!;
  run.slices.push(sliceExecutionStateSchema.parse({ schema: "aira.dev/slice-state/v1", slice: "S99",
    plan: run.snapshot.artifacts.find((s) => s.artifact.kind === "slice-plan")!.artifact, run: run.id, run_generation: "0", status: "pending", current_evidence: [], updated_at: run.updated_at }));
  await code(x.store.commit(request.transaction, request.blobs), "STORE_INTEGRITY");
});
test("new identity registration requires an actual immutable introduction revision", async () => {
  const x = await created(); clean.push(x.cleanup); const request = withRun(x.result);
  request.transaction.state.spec.identities.entries[0]!.introduced_in = "rev_unrecorded" as never;
  await code(x.store.commit(request.transaction, request.blobs), "STORE_INTEGRITY");
});
test("legacy generic Design and old development Spec schemas fail explicit dispatch", () => {
  const f = fixture();
  for (const schema of ["aira.dev/design/v1", "aira.dev/spec/v1", "aira.dev/requirements/v1", "aira.dev/tasks/v1", "aira.dev/mode-profile/v1"]) {
    expect(() => parseRecord({ ...f.architecture, schema })).toThrow();
  }
  const encoded = encodeRecord(f.product); expect(encoded.reference.contract).toBe("aira.dev/product/v1");
});
