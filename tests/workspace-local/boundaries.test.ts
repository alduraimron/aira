import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "src", "workspace-local");
describe("06-2A adapter boundary", () => {
  test("no Git command or Git metadata parser, store, worker, Context resolver or write primitive", async () => {
    const files = (await readdir(root)).filter((name) => name.endsWith(".ts"));
    expect(files.sort()).toEqual(["comparison.ts", "fingerprint.ts", "index.ts", "inspect.ts", "manifest.ts", "policy.ts", "types.ts"]);
    for (const file of files) {
      const text = await readFile(join(root, file), "utf8");
      expect(text).not.toMatch(/(?:from|import\()\s*["'](?:node:child_process|node:process|simple-git|libgit2|\.\.\/storage|\.\.\/core|\.\.\/agent|\.\.\/worker|\.\.\/pi|\.\.\/cli|\.\.\/context\/resolver)/);
      expect(text).not.toMatch(/\b(?:execFile|execSync|spawn|mkdir|writeFile|rename|unlink|chmod|chown|rm|rmdir|copyFile|createWriteStream|WorkspaceStore)\s*\(/);
      expect(text).not.toMatch(/\b(?:git-index-parser|git-object-parser|simple-git)\b/);
    }
    const inspection = await readFile(join(root, "inspect.ts"), "utf8");
    expect(inspection).toContain("constants.O_RDONLY | constants.O_NOFOLLOW");
    expect(inspection).not.toContain("O_WRONLY"); expect(inspection).not.toContain("O_RDWR");
    expect(inspection).not.toContain("O_CREAT");
  });
});
