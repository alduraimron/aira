import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../src");
const domain = (p: string) => p === "canonical-json.ts" ||
  /^(spec\/domain|builtins|steering|tasks|revision|capabilities|verification|workspace|execution)\//.test(p) ||
  /^(approval\/spec-(records|policy)|context\/(declarations|snapshot))\.ts$/.test(p);
async function files(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...await files(name)); else if (name.endsWith(".ts")) result.push(name);
  }
  return result;
}
test("v2 storage ports stay provider-neutral and file adapters only depend inward", async () => {
  const all = await files(path.join(root, "storage")); expect(all.length).toBeGreaterThan(10);
  for (const file of all) {
    const name = path.relative(root, file), backend = name.startsWith("storage/file/");
    const source = await readFile(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function scan(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const reference = node.moduleSpecifier.text;
        if (reference.startsWith(".")) {
          const target = path.relative(root, path.resolve(path.dirname(file), `${reference}.ts`));
          expect(target.startsWith("storage/") || domain(target)).toBe(true);
          if (!backend) expect(target.startsWith("storage/file/")).toBe(false);
        } else {
          expect(reference === "zod" || (backend && reference.startsWith("node:"))).toBe(true);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw Error(`Dynamic import in storage: ${name}`);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) expect(["require", "fetch"].includes(node.expression.text)).toBe(false);
      if (!backend && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
        expect(["Bun", "process", "Deno"].includes(node.expression.text)).toBe(false);
      ts.forEachChild(node, scan);
    }
    scan(ast);
  }
});
