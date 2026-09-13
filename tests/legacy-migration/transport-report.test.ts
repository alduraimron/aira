import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareArchivePublication, planMigration, validateArchiveBlobs, reportMigrationPlan, validateMigrationReport,
  archiveCatalogSchema, migrationPlanSchema, archivePublicationSchema } from "../../src/migration";
import { hashBytes } from "../../src/storage/file/canonical-json";
import { identityHash } from "../../src/legacy/v1/identity";
import { project, policy, at, later, ids, emptyCatalog } from "./fixtures";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await project(); clean.push(x.cleanup); return x; }

test("exact run and surviving artifact transports are validated without writes", async () => {
  const x = await setup(), inspection = await x.inspect(), source = inspection.sources[0]!;
  const plan = planMigration(inspection, policy(), "operation_import"), publication = prepareArchivePublication(plan, inspection, later);
  const original = await x.reader.readRunBytes(source), inputs = [{ hash: hashBytes(original.bytes), bytes: original.bytes }];
  for (const a of source.source.observation.artifacts) if (a.observation.status === "present") {
    const artifact = await x.reader.readArtifact(source, a.path); inputs.push({ hash: hashBytes(artifact.bytes), bytes: artifact.bytes });
  }
  expect(() => validateArchiveBlobs(publication, inputs)).not.toThrow();
  expect(() => validateArchiveBlobs(publication, inputs.slice(1))).toThrow("unavailable");
  expect(() => validateArchiveBlobs(publication, inputs.map((b, i) => i === 0 ? { ...b, bytes: new Uint8Array([1]) } : b))).toThrow("differ");
  const changed = archivePublicationSchema.parse(publication); changed.records[0]!.original_timestamps.started_at = at;
  expect(() => validateArchiveBlobs(changed, inputs)).toThrow("metadata");
  expect(await readdir(join(x.root, ".aira"))).toEqual(["runs"]);
});
test("run byte capture rejects post-inspection replacement instead of serializing parsed JSON", async () => {
  const x = await setup(), item = await x.reader.inspect(ids[5]!, at), file = join(x.root, ".aira/runs", ids[5]!, "run.json");
  const original = await x.reader.readRunBytes(item); expect(original.bytes).toEqual(new Uint8Array(await readFile(file)));
  await writeFile(file, `${await readFile(file, "utf8")} `);
  await expect(x.reader.readRunBytes(item)).rejects.toMatchObject({ code: "LEGACY_SOURCE_CHANGED" });
});
test("frozen v1 retains BOM rejection and duplicate-key JSON semantics", async () => {
  const x = await setup(), file = join(x.root, ".aira/runs", ids[5]!, "run.json"), bytes = await readFile(file, "utf8");
  await writeFile(file, `\ufeff${bytes}`); const bom = await x.reader.inspect(ids[5]!, at);
  expect(bom.status).toBe("invalid"); if (bom.status === "invalid") expect(bom.code).toBe("LEGACY_INVALID_JSON");
  await writeFile(file, bytes.replace('"version": 1', '"version": 2, "version": 1'));
  expect((await x.reader.inspect(ids[5]!, at)).status).toBe("valid");
});
test("complete report validation rejects omitted sources even if report schema is valid", async () => {
  const x = await setup(), plan = planMigration(await x.inspect(), policy(), "operation_import"), report = reportMigrationPlan(plan);
  expect(() => validateMigrationReport(plan, report)).not.toThrow();
  expect(() => validateMigrationReport(plan, { ...report, entries: [] })).toThrow("every planned source");
});
test("metadata-only imported history cannot silently satisfy a later surviving-byte import policy", async () => {
  const x = await setup(), inspected = await x.inspect(), plan = planMigration(inspected, policy("archive-metadata"), "operation_metadata"), publication = prepareArchivePublication(plan, inspected, later);
  const catalog = archiveCatalogSchema.parse({ ...emptyCatalog(), head: { commit_id: identityHash("synthetic receipt"), sequence: "1" }, records: publication.records });
  const current = await x.inspect(later, catalog), next = planMigration(current, policy(), "operation_more");
  expect(next.body.entries[0]!.actions[1]).toEqual({ kind: "manual", code: "MIG_SOURCE_CONFLICT" });
});
test("archive proposals reject fake content copying and duplicate actions at decode", async () => {
  const x = await setup(), fresh = await x.inspect(), parsed = migrationPlanSchema.parse(planMigration(fresh, policy(), "operation_import"));
  const copy = parsed.body.entries[0]!.actions.find((a) => a.kind === "copy-observed-blob")!;
  parsed.body.entries[0]!.actions.push(copy); parsed.id = identityHash(parsed.body);
  expect(migrationPlanSchema.safeParse(parsed).success).toBe(false);
});
