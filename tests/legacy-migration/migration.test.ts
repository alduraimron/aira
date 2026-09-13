import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile, rm, mkdir, cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectMigration, planMigration, validateMigrationPlan, prepareArchivePublication, checkArchivePublication,
  reportMigrationPlan, preflightMigration, reportMigrationRestart, migrationPlanSchema, migrationPolicySchema, archiveRecordSchema,
  archiveCatalogSchema, archivePublicationSchema, archiveReceiptSchema, migrationReportSchema, reportStatuses } from "../../src/migration";
import { identityHash } from "../../src/legacy/v1/identity";
import { at, later, ids, project, policy, fixtures, emptyCatalog } from "./fixtures";
import type { MigrationPlan } from "../../src/migration/types";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup(selected?: string[]) { const x = await project(selected); clean.push(x.cleanup); return x; }

async function prepared() {
  const x = await setup(), inspection = await x.inspect(), plan = planMigration(inspection, policy(), "operation_import");
  const publication = prepareArchivePublication(plan, inspection, later);
  // Synthetic provider-neutral committed receipt, NOT a file import/crash test.
  const head = { commit_id: identityHash({ synthetic: "archive-commit" }), sequence: "1" };
  const receipt = archiveReceiptSchema.parse({ schema: "aira.dev/legacy-archive-receipt/v1", operation: plan.body.operation, input_hash: identityHash(publication), head, publication });
  const catalog = archiveCatalogSchema.parse({ ...emptyCatalog(), head, records: publication.records });
  return { ...x, inspection, plan, publication, receipt, catalog };
}

test("inspection classifies all literal v1 semantics without converting workflow meaning", async () => {
  const x = await setup(ids), inspection = await x.inspect();
  const codes = inspection.findings.map((f) => f.code);
  for (const code of ["MIG_VALID_LEGACY", "MIG_ARTIFACT_PRESENT", "MIG_HISTORICAL_BYTES_UNKNOWN", "MIG_REVISION_PENDING", "MIG_REVISION_RESOLVED",
    "MIG_APPROVAL_UNATTRIBUTABLE", "MIG_INTERRUPTED_RUN", "MIG_CONTINUATION_UNSUPPORTED", "MIG_DIAGNOSTIC_IMPORTABLE"])
    expect(codes).toContain(code as never);
  expect(inspection.sources.length).toBe(9); expect(await readdir(join(x.root, ".aira"))).toEqual(["runs"]);
});
test("corrupt/unsupported records and absent artifact references get distinct findings", async () => {
  const x = await setup();
  for (const id of ["20260826-110001-b1000001", "20260826-110002-b1000002"])
    await cp(join(fixtures, "invalid", id), join(x.root, ".aira/runs", id), { recursive: true });
  await rm(join(x.root, ".aira/runs", ids[5]!, "artifacts/plan-v1.md"));
  const codes = (await x.inspect()).findings.map((f) => f.code);
  for (const code of ["MIG_CORRUPT_LEGACY", "MIG_UNSUPPORTED_LEGACY", "MIG_ARTIFACT_MISSING"]) expect(codes).toContain(code as never);
});
test.each(["preserve", "archive-metadata", "archive-surviving"] as const)("explicit %s policy yields immutable exact actions", async (mode) => {
  const x = await setup(), inspected = await x.inspect(), plan = planMigration(inspected, policy(mode), "operation_import");
  const actions = plan.body.entries[0]!.actions;
  expect(actions[0]!.kind).toBe("preserve-source"); expect(actions.some((a) => a.kind === "register-history")).toBe(mode !== "preserve");
  expect(actions.filter((a) => a.kind === "copy-observed-blob").length).toBe(mode === "archive-surviving" ? 2 : 0);
  expect(Object.isFrozen(plan.body.entries[0]!.source.observation)).toBe(true);
  expect(() => { (plan.body.entries as unknown[]).push({}); }).toThrow();
  expect(plan.body.entries[0]!.source.id).toBe(inspected.sources[0]!.source.id);
  expect(reportMigrationPlan(plan).fully_successful).toBe(false);
});
test("same state/policy/operation has identical plan despite inspection time or source enumeration order", async () => {
  const x = await setup([ids[5]!, ids[6]!]), a = await x.inspect(), b = await x.inspect(later);
  const reversed = inspectMigration({ ...b, sources: [...b.sources].reverse() });
  expect(planMigration(a, policy(), "operation_import")).toEqual(planMigration(reversed, policy(), "operation_import"));
  expect(planMigration(a, policy("archive-metadata"), "operation_import").id).not.toBe(planMigration(a, policy(), "operation_import").id);
});
test("generic migrate-everything flag and unknown future plans/policies fail strict parsing", async () => {
  const x = await setup(), plan = planMigration(await x.inspect(), policy(), "operation_import");
  expect(migrationPolicySchema.safeParse({ migrate: true }).success).toBe(false);
  expect(migrationPlanSchema.safeParse({ ...plan, body: { ...plan.body, schema: "aira.dev/migration-plan/v2" } }).success).toBe(false);
  expect(migrationPlanSchema.safeParse({ ...plan, id: identityHash("wrong") }).success).toBe(false);
});
test("schema-valid but forged policy actions are rejected by deterministic preflight", async () => {
  const x = await setup(), fresh = await x.inspect(), plan = migrationPlanSchema.parse(planMigration(fresh, policy(), "operation_import"));
  plan.body.entries[0]!.actions = [{ kind: "preserve-source" }]; plan.id = identityHash(plan.body);
  expect(migrationPlanSchema.safeParse(plan).success).toBe(true);
  expect(() => validateMigrationPlan(plan, fresh)).toThrow("Plan no longer matches");
});
for (const mutation of ["run-json", "artifact", "artifact-missing", "missing-becomes-present", "run-deleted", "whitespace-only-json"]) test(`stale plan rejected after ${mutation} source mutation`, async () => {
  const x = await setup(), run = join(x.root, ".aira/runs", ids[5]!), artifact = join(run, "artifacts/plan-v1.md");
  if (mutation === "missing-becomes-present") await rm(artifact);
  const inspection = await x.inspect(), plan = planMigration(inspection, policy(), "operation_import");
  if (mutation === "run-json") { const json = JSON.parse(await readFile(join(run, "run.json"), "utf8")); json.workflow = "changed"; await writeFile(join(run, "run.json"), JSON.stringify(json)); }
  if (mutation === "whitespace-only-json") await writeFile(join(run, "run.json"), `${await readFile(join(run, "run.json"), "utf8")}\n`);
  if (["artifact", "missing-becomes-present"].includes(mutation)) await writeFile(artifact, "different surviving bytes");
  if (mutation === "artifact-missing") await rm(artifact);
  if (mutation === "run-deleted") await rm(run, { recursive: true });
  const fresh = await x.inspect(later), report = preflightMigration(plan, fresh);
  expect(report.entries[0]!.status).toBe("stale-plan-rejected"); expect(report.entries[0]!.code).toBe("MIG_STALE_PLAN"); expect(report.fully_successful).toBe(false);
  expect(() => prepareArchivePublication(plan, fresh, later)).toThrow();
  expect(await readdir(join(x.root, ".aira"))).toEqual(["runs"]);
});
test("manual and skip policies preserve sources and expose incomplete results", async () => {
  const x = await setup(), file = join(x.root, ".aira/runs", ids[5]!, "run.json"); await writeFile(file, "bad");
  const inspection = await x.inspect();
  const skip = planMigration(inspection, policy(), "operation_skip"), manual = planMigration(inspection, { ...policy(), invalid: "manual" }, "operation_manual");
  expect(skip.body.entries[0]!.actions[1]!.kind).toBe("skip"); expect(manual.body.entries[0]!.actions[1]!.kind).toBe("manual");
  expect(reportMigrationPlan(skip).entries[0]!.status).toBe("corrupt"); expect(reportMigrationPlan(manual).entries[0]!.status).toBe("manual-action-required");
  expect(await readFile(file, "utf8")).toBe("bad");
});
test("missing artifacts can require manual intervention or metadata-only preservation", async () => {
  const x = await setup(); await rm(join(x.root, ".aira/runs", ids[5]!, "artifacts"), { recursive: true }); const inspection = await x.inspect();
  const manual = planMigration(inspection, { ...policy(), unavailable_artifacts: "manual" }, "operation_import");
  expect(manual.body.entries[0]!.actions[1]!.kind).toBe("manual");
  const permitted = planMigration(inspection, policy(), "operation_import");
  const publication = prepareArchivePublication(permitted, inspection, later); expect(publication.records[0]!.artifacts).toEqual([]);
  expect(publication.records[0]!.source.observation.artifacts.every((a) => a.observation.status === "missing")).toBe(true);
});
test("archive proposals preserve exact provenance but never become Specs or executable records", async () => {
  const x = await prepared(), r = x.publication.records[0]!;
  expect(r.id).toMatch(/^legacy_/); expect(r.source_format).toBe("v1"); expect(r.executable).toBe(false);
  expect(r.run_json.provenance).toBe("observed-during-import"); expect(r.run_json.historical_identity).toBe("not-recorded-in-v1");
  expect(r.run_json.hash).toBe(x.inspection.sources[0]!.source.observation.run_json!.hash);
  expect(r.original_run_id).toBe(ids[5]!); expect(r.imported_at).toBe(later); expect(r.original_timestamps.started_at).not.toBe(later);
  expect(archiveRecordSchema.safeParse({ ...r, spec_id: "spec_fake" }).success).toBe(false);
  expect(archiveRecordSchema.safeParse({ ...r, executable: true }).success).toBe(false);
  expect(archiveRecordSchema.safeParse({ ...r, run_json: { ...r.run_json, hash: identityHash("invented") } }).success).toBe(false);
  expect(await readdir(join(x.root, ".aira"))).toEqual(["runs"]); // Proposals are not persisted imports.
});
test("archive transaction must contain every planned source and exact selected blob references", async () => {
  const x = await setup([ids[5]!, ids[6]!]), fresh = await x.inspect(), p = prepareArchivePublication(planMigration(fresh, policy(), "operation_import"), fresh, later);
  expect(archivePublicationSchema.safeParse({ ...p, records: p.records.slice(0, 1) }).success).toBe(false);
  expect(archivePublicationSchema.safeParse({ ...p, records: p.records.map((r) => ({ ...r, artifacts: [] })) }).success).toBe(false);
});
test("pure archive CAS and idempotency rules use exact OperationId input before stale CAS", async () => {
  const x = await prepared(); expect(checkArchivePublication(x.publication, emptyCatalog(), null)).toBe("publish");
  expect(checkArchivePublication(x.publication, x.catalog, x.receipt)).toBe("replay");
  expect(() => checkArchivePublication(x.publication, x.catalog, null)).toThrow("Stale archive CAS");
  const changed = archivePublicationSchema.parse({ ...x.publication, imported_at: at, records: x.publication.records.map((r) => ({ ...r, imported_at: at })) });
  expect(() => checkArchivePublication(changed, x.catalog, x.receipt)).toThrow("different immutable input");
});
test("existing exact source is already imported; changed source needs manual conflict handling", async () => {
  const x = await prepared();
  const existing = await x.inspect(later, x.catalog); expect(existing.findings.some((f) => f.code === "MIG_ALREADY_IMPORTED")).toBe(true);
  const plan = planMigration(existing, policy(), "operation_again"); expect(plan.body.entries[0]!.actions[1]!.kind).toBe("already-imported");
  await writeFile(join(x.root, ".aira/runs", ids[5]!, "artifacts/plan-v1.md"), "new bytes");
  const changed = await x.inspect(later, x.catalog); expect(changed.findings.some((f) => f.code === "MIG_SOURCE_CONFLICT")).toBe(true);
  expect(planMigration(changed, policy(), "operation_conflict").body.entries[0]!.actions[1]!.kind).toBe("manual");
});
test("restart report distinguishes no authority, complete receipt and missing receipt", async () => {
  const x = await prepared();
  expect(reportMigrationRestart(x.plan, emptyCatalog(), null).fully_successful).toBe(false);
  const committed = reportMigrationRestart(x.plan, x.catalog, x.receipt); expect(committed.entries[0]!.status).toBe("imported"); expect(committed.fully_successful).toBe(true);
  expect(reportMigrationRestart(x.plan, x.catalog, null).entries[0]!.status).toBe("failed");
  // These are pure receipt contract tests, not claims of an implemented crash-safe backend.
});
test("a partial catalog cannot be called a fully successful migration", async () => {
  const x = await setup([ids[5]!, ids[6]!]), fresh = await x.inspect(), plan = planMigration(fresh, policy(), "operation_import"), publication = prepareArchivePublication(plan, fresh, later);
  const head = { commit_id: identityHash("synthetic"), sequence: "1" };
  const receipt = archiveReceiptSchema.parse({ schema: "aira.dev/legacy-archive-receipt/v1", operation: plan.body.operation, input_hash: identityHash(publication), head, publication });
  const partial = archiveCatalogSchema.parse({ ...emptyCatalog(), head, records: publication.records.slice(0, 1) });
  expect(reportMigrationRestart(plan, partial, receipt).fully_successful).toBe(false);
});
test.each([...reportStatuses])("report represents stable outcome %s without conflating success", async (status) => {
  const x = await setup(), plan = planMigration(await x.inspect(), policy(), "operation_import");
  const report = { schema: "aira.dev/migration-report/v1", plan_id: plan.id, operation: plan.body.operation, phase: "execution", fully_successful: false,
    entries: [{ source_id: plan.body.entries[0]!.source.id, status, code: "MIG_TEST_OUTCOME", detail: "explicit result" }] };
  expect(migrationReportSchema.safeParse(report).success).toBe(true);
  expect(migrationReportSchema.safeParse({ ...report, fully_successful: true }).success).toBe(["imported", "preserved-in-place", "already-imported"].includes(status));
});
test("newly discovered unrelated runs do not alter explicitly planned source identities", async () => {
  const x = await setup(), plan = planMigration(await x.inspect(), policy(), "operation_import");
  await cp(join(fixtures, "valid", ids[0]!), join(x.root, ".aira/runs", ids[0]!), { recursive: true });
  expect(validateMigrationPlan(plan, await x.inspect())).toEqual(plan);
});
test("unsafe v2 FORMAT requires intervention, never implicit repair or conversion", async () => {
  const x = await setup(); await mkdir(join(x.root, ".aira/state/v2"), { recursive: true });
  await writeFile(join(x.root, ".aira/state/v2/FORMAT"), '{"schema":"aira.dev/file-store/v99"}');
  const inspection = await x.inspect(); expect(inspection.findings.some((f) => f.code === "MIG_V2_UNAVAILABLE")).toBe(true);
  const plan = planMigration(inspection, policy(), "operation_import"); expect(plan.body.entries[0]!.actions[1]!.kind).toBe("manual");
  expect(await readFile(join(x.root, ".aira/state/v2/FORMAT"), "utf8")).toContain("v99");
});
