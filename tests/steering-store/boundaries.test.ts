import { afterEach, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { code } from "../storage-v2/fixtures";
import { created, project, revision, temporary } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(absolute));
    else if (entry.name.endsWith(".ts")) result.push(absolute);
  }
  return result;
}

test("SteeringStore provider-neutral ports do not import file, Pi, CLI, Context resolver, or authoring adapters", async () => {
  const root = resolve(import.meta.dir, "../../src");
  for (const name of ["storage/steering-store.ts", "storage/steering-types.ts", "storage/steering-transaction.ts",
    "storage/steering-snapshot-store.ts", "storage/steering-snapshot-types.ts"]) {
    const source = await readFile(join(root, name), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    function scan(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const reference = node.moduleSpecifier.text;
        expect(reference).not.toMatch(/storage\/file|(?:^|\/)pi(?:\/|$)|(?:^|\/)cli(?:\/|$)|context\/resolver|filesystem/);
        expect(reference.startsWith("node:")).toBe(false);
      }
      ts.forEachChild(node, scan);
    }
    scan(ast);
    expect(source).not.toContain(".aira/steering");
    expect(source).not.toContain("AGENTS.md");
  }
});

test("pure Steering domain remains independent of every storage module", async () => {
  const root = resolve(import.meta.dir, "../../src/steering");
  for (const file of await files(root)) {
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*storage(?:\/|["'])/);
  }
});

test("project Steering uses its own fixed authority layout, never a fake Spec or resource-ID path", async () => {
  const publication = revision();
  const context = await created([publication]); clean.push(context.cleanup);
  const root = context.store.fs.paths.root;
  expect(relative(root, context.store.fs.paths.steeringHead())).toBe("steering/HEAD");
  expect(relative(root, context.store.fs.paths.steeringCommit(context.result.commit_id)))
    .toBe(`steering/commits/${context.result.commit_id.slice(7)}.json`);
  expect(relative(root, context.store.fs.paths.steeringLock())).toBe("locks/steering/project.lock");
  expect(context.store.fs.paths.steeringHead()).not.toContain("specs/");
  expect(context.store.fs.paths.steeringHead()).not.toContain(publication.revision.identity.id);
});

test("invalid encoded project identities are rejected without path construction or traversal", async () => {
  const context = await created(); clean.push(context.cleanup);
  for (const identity of ["../escape", "acme/other", "ACME", "acme%2fother", "acme\\other"])
    await code(context.store.loadRegistry(identity as never), "STORE_PATH_UNSAFE");
});

test("ordinary Steering reads never create, migrate, lock, repair, or clean storage", async () => {
  const context = await temporary(); clean.push(context.cleanup);
  await code(context.store.loadRegistry(project), "STORE_NOT_FOUND");
  expect(await context.store.fs.present(join(context.root, ".aira"))).toBe(false);
});
