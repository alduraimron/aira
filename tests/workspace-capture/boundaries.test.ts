import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceFingerprint, workspacePathManifestSchema, workspacePathManifestV2Schema } from "../../src/workspace/fingerprint-v2";
import { fingerprint, entry } from "../workspace-domain/fixtures";
import { hashCanonical } from "../../src/canonical-json";

const root = join(import.meta.dir, "..", "..", "src", "workspace-capture");
describe("06-2B2 versioned domain corrections and adapter boundary", () => {
  test("historical v1 manifest remains exact, while v2 requires tagged Git OIDs and local-only directories", () => {
    const previous = fingerprint();
    expect(previous.subject.manifest.schema).toBe("aira.dev/workspace-path-manifest/v1");
    expect(workspacePathManifestSchema.safeParse(previous.subject.manifest).success).toBe(true);
    expect(workspacePathManifestV2Schema.safeParse(previous.subject.manifest).success).toBe(false);
    const oldDigest = previous.digest;
    expect(createWorkspaceFingerprint({ binding: previous.subject, entries: [entry("src/main.ts")],
      repository_components: previous.subject.repository_components }).digest).toBe(oldDigest);
    expect(workspacePathManifestSchema.safeParse({ schema: "aira.dev/workspace-path-manifest/v1",
      entries: [{ path: "file", worktree: { category: "tracked", state: { kind: "deleted" } },
        index: { stage: 0, state: { kind: "git-object", schema: "aira.dev/workspace-git-index-state/v1",
          object_format: "sha1", oid: "a".repeat(40), mode: "100644" } } }], hash: hashCanonical("x") }).success).toBe(false);
    const malformedOid = { path: "file", worktree: { category: "tracked", state: { kind: "deleted" } },
      index: { stage: 0, state: { kind: "git-object", schema: "aira.dev/workspace-git-index-state/v1",
        object_format: "sha256", oid: "a".repeat(40), mode: "100644" } } };
    const subject = { schema: "aira.dev/workspace-path-manifest/v2", entries: [malformedOid] };
    expect(workspacePathManifestV2Schema.safeParse({ ...subject, hash: hashCanonical(subject) }).success).toBe(false);
  });
  test("capture layer is read-only orchestration and never imports persistence, execution or workers", async () => {
    const names = (await readdir(root)).filter((name) => name.endsWith(".ts")).sort();
    expect(names).toEqual(["capture.ts", "coherence.ts", "compose.ts", "index.ts", "types.ts"]);
    for (const name of names) {
      const text = await readFile(join(root, name), "utf8");
      expect(text).not.toMatch(/node:child_process|node:fs\/promises|\b(?:spawn|execFile|checkout|stash|reset|writeFile|mkdir|rm|WorkspaceStore|createWorktree)\s*\(/);
      expect(text).not.toMatch(/\.\.\/(?:storage|core|agent|worker|pi|cli|scheduler|executor|capabilities|context\/resolver)/);
    }
    const pure = await readFile(join(root, "compose.ts"), "utf8");
    expect(pure).not.toContain("inspectWorkspaceGit(");
    expect(pure).not.toContain("inspectWorkspaceLocalTree(");
  });
});
