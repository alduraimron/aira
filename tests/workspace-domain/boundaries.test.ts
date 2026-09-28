import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// The test uses fs to inspect imports; no production Workspace module may use it.
test("06-1 workspace transitive imports are pure and contain no effectful adapter", async () => {
  const root = path.resolve(import.meta.dir, "../../src");
  const workspace = path.join(root, "workspace");
  const files = (await readdir(workspace)).filter((file) => file.endsWith(".ts"));
  const visited = new Set<string>();
  async function inspect(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    const relative = path.relative(root, file);
    expect(relative === "canonical-json.ts" || /^(workspace|spec\/domain|context\/declarations|builtins|execution|verification|tasks|approval|capabilities|revision|steering)\//.test(relative) || relative === "context/declarations.ts").toBe(true);
    const source = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function walk(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        throw new Error(`Dynamic import in ${relative}`);
      ts.forEachChild(node, walk);
    }
    walk(ast);
    for (const dependency of imports) {
      if (dependency === "zod") continue;
      expect(dependency.startsWith(".")).toBe(true);
      const target = path.resolve(path.dirname(file), `${dependency}.ts`);
      expect(path.relative(root, target).startsWith("..")).toBe(false);
      await inspect(target);
    }
  }
  for (const file of files) await inspect(path.join(workspace, file));
  for (const file of files) {
    const source = await readFile(path.join(workspace, file), "utf8");
    expect(/\b(?:node:fs|node:child_process|Bun\.|process\.|fetch\(|require\(|storage\/file|scheduler\/|core\/|agent\/|pi\/|cli\/)\b/.test(source)).toBe(false);
  }
  expect(visited.size).toBeGreaterThan(files.length);
});
