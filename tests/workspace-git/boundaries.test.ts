import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const directory = join(import.meta.dir, "..", "..", "src", "workspace-git");
describe("06-2B1 adapter boundaries", () => {
  test("only the narrow runner starts a process; no preparation, store, local file hashing or fingerprint composer", async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".ts")).sort();
    expect(names).toEqual(["comparison.ts", "index.ts", "inspect.ts", "observation.ts", "policy.ts", "runner.ts", "source.ts", "types.ts"]);
    for (const name of names) {
      const code = await readFile(join(directory, name), "utf8");
      if (name !== "runner.ts") expect(code).not.toMatch(/node:child_process|\bspawn\(|\bexecFile\(/);
      expect(code).not.toMatch(/\b(?:WorkspaceStore|createWorkspaceFingerprint|constructLocalFingerprint|checkout|git worktree add|git clone|git reset|git clean|git stash)\s*\(/);
      expect(code).not.toMatch(/\.\.\/storage|\.\.\/core|\.\.\/agent|\.\.\/worker|\.\.\/pi|\.\.\/cli/);
    }
    const runner = await readFile(join(directory, "runner.ts"), "utf8");
    expect(runner).toContain('shell: false');
    expect(runner).toContain('GIT_OPTIONAL_LOCKS: "0"');
    expect(runner).toContain('GIT_NO_LAZY_FETCH: "1"');
    expect(runner).not.toMatch(/\b(?:execSync|spawnSync|writeFile|mkdir|rename|unlink|rm)\s*\(/);
  });
});
