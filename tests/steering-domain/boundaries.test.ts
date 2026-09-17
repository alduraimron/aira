import { expect, test } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../src");
const steeringRoot = path.join(root, "steering");
const pureDomain = (file: string): boolean => file === "canonical-json.ts" ||
  /^(steering|spec\/domain|builtins|tasks|revision|capabilities|verification|workspace|execution)\//.test(file) ||
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

async function resolveImport(file: string, reference: string): Promise<string> {
  const direct = path.resolve(path.dirname(file), `${reference}.ts`);
  try {
    if ((await stat(direct)).isFile()) return direct;
  } catch {}
  return path.resolve(path.dirname(file), reference, "index.ts");
}

test("INV-DOMAIN-001/STEER boundary: Steering transitive closure stays pure", async () => {
  const initial = await files(steeringRoot);
  const visited = new Set<string>();

  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    const relative = path.relative(root, file);
    expect(pureDomain(relative)).toBe(true);

    const source = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const references: string[] = [];
    function scan(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        references.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`Dynamic import in Steering closure: ${relative}`);
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
      await visit(await resolveImport(file, reference));
    }
  }

  for (const file of initial) await visit(file);
  expect(initial.length).toBeGreaterThanOrEqual(6);
  expect(visited.size).toBeGreaterThan(initial.length);
});

test("Steering source has no filesystem, Pi, CLI, storage-adapter, executor, or Context-resolver dependency", async () => {
  for (const file of await files(steeringRoot)) {
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:storage\/file|\/pi\/|\/cli\/|\/workflow\/|\/executor\/)/);
    expect(source).not.toContain(".aira/steering");
    expect(source).not.toContain("AGENTS.md");
  }
});
