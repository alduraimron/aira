import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../src");
const domainFile = (file: string): boolean => /^(spec\/domain|tasks|revision|capabilities|verification|workspace|execution)\//.test(file) ||
  /^(approval\/spec-(records|policy)|context\/(declarations|snapshot))\.ts$/.test(file);
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(absolute));
    else if (entry.name.endsWith(".ts")) result.push(absolute);
  }
  return result.sort();
}
test("INV-DOMAIN-001/AGENT-001/LEGACY-003: transitive v2 import closure is pure and isolated from v1", async () => {
  const all = await files(root), visited = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    const relative = path.relative(root, file);
    expect(domainFile(relative)).toBe(true);
    const source = await readFile(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const references: string[] = [];
    function scan(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) references.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`Dynamic import in domain: ${relative}`);
        if (ts.isIdentifier(node.expression)) expect(["fetch", "require", "setTimeout", "setInterval"].includes(node.expression.text)).toBe(false);
        if (ts.isPropertyAccessExpression(node.expression)) expect(["Date.now", "Math.random"].includes(node.expression.getText(ast))).toBe(false);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
        expect(["Bun", "process", "Deno"].includes(node.expression.text)).toBe(false);
      ts.forEachChild(node, scan);
    }
    scan(ast);
    for (const reference of references) {
      if (reference === "zod") continue;
      expect(reference.startsWith(".")).toBe(true);
      await visit(path.resolve(path.dirname(file), reference + ".ts"));
    }
  }
  for (const file of all.filter((file) => domainFile(path.relative(root, file)))) await visit(file);
  expect(visited.size).toBeGreaterThan(35);
  // The old runtime has no new domain imports; coexistence does not activate v2 behavior.
  for (const file of all.filter((file) => !domainFile(path.relative(root, file)))) {
    const source = await readFile(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const reference = statement.moduleSpecifier.text;
      if (reference.startsWith(".")) expect(domainFile(path.relative(root, path.resolve(path.dirname(file), reference + ".ts")))).toBe(false);
    }
  }
});
