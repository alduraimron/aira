import { mkdtemp, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LegacyV1Reader } from "../../src/legacy/v1/reader";
import { LegacyFiles } from "../../src/legacy/v1/files";
import { detectReadFormat } from "../../src/compatibility/format";
import { inspectMigration } from "../../src/migration/inspect";
import { archiveCatalogSchema, migrationPolicySchema } from "../../src/migration/schema";
export const fixtures = resolve(import.meta.dir, "../fixtures/legacy-v1");
export const at = "2026-09-12T12:00:00.000Z";
export const later = "2026-09-13T12:00:00.000Z";
export const ids = Array.from({ length: 9 }, (_, i) => `20260826-10000${i + 1}-a100000${i + 1}`);
export const emptyCatalog = () => archiveCatalogSchema.parse({ schema: "aira.dev/legacy-archive-catalog/v1", project: "project_test", head: null, records: [] });
export const policy = (history: "preserve" | "archive-metadata" | "archive-surviving" = "archive-surviving") => migrationPolicySchema.parse({
  schema: "aira.dev/migration-policy/v1", history, invalid: "skip", unavailable_artifacts: "metadata-only",
});
export async function project(selected: readonly string[] = [ids[5]!]) {
  const root = await mkdtemp("/var/tmp/aira-legacy-migration-"); await mkdir(join(root, ".aira", "runs"), { recursive: true });
  for (const id of selected) await cp(join(fixtures, "valid", id), join(root, ".aira", "runs", id), { recursive: true });
  const reader = new LegacyV1Reader(root, { projectIdentity: "project_test" }), layout = new LegacyFiles(root);
  async function inspect(time = at, archive = emptyCatalog()) {
    const sources = [];
    for (const id of (await reader.discover()).ids) sources.push(await reader.inspect(id, time));
    return inspectMigration({ project: "project_test", sources, format: await detectReadFormat(layout), archive });
  }
  return { root, reader, layout, inspect, cleanup: () => rm(root, { recursive: true, force: true }) };
}
