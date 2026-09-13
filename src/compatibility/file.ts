import { join } from "node:path";
import { LegacyV1Reader } from "../legacy/v1/reader";
import { LegacyFiles } from "../legacy/v1/files";
import { FileSpecStore } from "../storage/file/spec-store";
import { specIdFromKey } from "../storage/file/paths";
import { detectReadFormat, canDecodeV2 } from "./format";
import { CompatibilityQueries, type QueryFailure, type V2SpecReader } from "./query";

export function fileCompatibilityQueries(root: string, projectIdentity: string): CompatibilityQueries {
  const layout = new LegacyFiles(root), store = new FileSpecStore(root);
  const v2: V2SpecReader = {
    async list() {
      const format = await detectReadFormat(layout);
      if (!canDecodeV2(format)) throw Object.assign(new Error(format.v2.detail), { code: format.v2.status === "available" ? "FORMAT_LAYOUT_AMBIGUOUS" : format.v2.code });
      const ids = [], failures: QueryFailure[] = [];
      for (const key of await store.fs.entries(join(store.fs.paths.root, "specs"))) try {
        const id = specIdFromKey(key);
        if (await store.commits.readHead(id)) ids.push(id);
        else failures.push({ source_format: "v2", id, code: "QUERY_NONAUTHORITATIVE_DIRECTORY", detail: "No HEAD; commits and derived files do not establish a Spec" });
      } catch (error) { failures.push({ source_format: "v2", id: null, code: error && typeof error === "object" && "code" in error ? String(error.code) : "QUERY_IO", detail: key }); }
      return { ids, failures };
    },
    load: (id) => store.loadSpec(id, "full"),
  };
  return new CompatibilityQueries(() => detectReadFormat(layout), new LegacyV1Reader(root, { projectIdentity }), v2);
}
