import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
const root = path.resolve(import.meta.dir, "../../src");
async function files(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(name)); else if (name.endsWith(".ts")) result.push(name);
  }
  return result;
}
async function references(file: string) {
  const source = await readFile(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), imports: string[] = [];
  function scan(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && ["require", "fetch"].includes(node.expression.text)))
      throw Error(`Forbidden hidden dependency: ${file}`);
    ts.forEachChild(node, scan);
  }
  scan(ast); return imports;
}
test("frozen v1 owns all historical types/schema/path rules and has no runtime or v2 imports", async () => {
  for (const file of await files(path.join(root, "legacy/v1"))) for (const ref of await references(file)) {
    if (ref.startsWith(".")) expect(path.resolve(path.dirname(file), ref).startsWith(path.join(root, "legacy/v1/"))).toBe(true);
    else expect(["zod", "node:crypto", "node:fs", "node:fs/promises", "node:path"].includes(ref)).toBe(true);
  }
});
test("legacy filesystem adapter has no writing, lock or repair imports", async () => {
  const text = await readFile(path.join(root, "legacy/v1/files.ts"), "utf8");
  const ast = ts.createSourceFile("files.ts", text, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings))
    for (const item of node.importClause.namedBindings.elements) expect(["mkdir", "rename", "writeFile", "unlink", "rm", "rmdir", "appendFile"].includes(item.name.text)).toBe(false);
});
test("v2 domain has no reverse legacy/compatibility/migration dependency", async () => {
  for (const dir of ["spec/domain", "builtins", "tasks", "revision", "execution", "verification", "capabilities", "workspace"])
    for (const file of await files(path.join(root, dir))) for (const ref of await references(file)) expect(/legacy|compatibility\/query|migration/.test(ref)).toBe(false);
});
test("migration transitive dependency closure is deterministic, with no filesystem/process/runtime adapters", async () => {
  const visited = new Set<string>(), queue = await files(path.join(root, "migration"));
  while (queue.length) {
    const file = queue.pop()!; if (visited.has(file)) continue; visited.add(file);
    expect(/\/(storage\/file|legacy\/v1\/files|legacy\/v1\/reader|core|cli|pi|executor|agent)\//.test(file)).toBe(false);
    for (const ref of await references(file)) {
      if (!ref.startsWith(".")) { expect(["zod", "node:crypto"].includes(ref)).toBe(true); continue; }
      // Type-only imports have no runtime effects but their declared modules must also
      // stay within the intentional inward domain/observation boundary.
      const target = path.resolve(path.dirname(file), `${ref}.ts`);
      const ast = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      const runtime = ast.statements.some((n) => ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === ref && !n.importClause?.isTypeOnly);
      if (runtime) queue.push(target);
    }
  }
  expect(visited.size).toBeGreaterThan(10);
});
test("application-neutral queries compose distinct reader ports without frontends or concrete adapters", async () => {
  const refs = await references(path.join(root, "compatibility/query.ts"));
  expect(refs.some((r) => r.includes("legacy/v1"))).toBe(true); expect(refs.some((r) => r.includes("storage/types"))).toBe(true);
  expect(refs.some((r) => /storage\/file|executor|\/pi|\/core|\/cli/.test(r))).toBe(false);
});
