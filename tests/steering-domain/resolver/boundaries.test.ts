import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { resolveSteering } from "../../../src/steering";
import { request } from "./fixtures";

const directory = path.resolve(import.meta.dir, "../../../src/steering");
test("05C-2 resolver imports only existing pure domain contracts, never adapters or platform APIs", async () => {
  const allowed = /^\.\/(?:ids|types|schema|applicability|authority|resources|resolution-contract|scope|hierarchy|conflicts|resolution)$/;
  const domain = /^\.\.\/(?:spec\/domain\/(?:ids|primitives)|context\/declarations)$/;
  for (const name of ["resolution-contract.ts", "scope.ts", "hierarchy.ts", "conflicts.ts", "resolution.ts"]) {
    const source = await readFile(path.join(directory, name), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const ref = node.moduleSpecifier.text;
        expect(ref === "zod" || allowed.test(ref) || domain.test(ref)).toBe(true);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error("Dynamic dependency in resolver");
      if (ts.isIdentifier(node)) expect(["process", "Bun", "Deno", "fetch", "require"].includes(node.text)).toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(source).not.toMatch(/Date\.now|Math\.random|createHash|BlobStore|SpecStore|SteeringSnapshotId/);
  }
});

test("05C-2 result is an intermediate decision record, not a constructed snapshot", () => {
  const result = resolveSteering(request([]));
  expect(result.status).toBe("resolved");
  for (const key of ["id", "hash", "snapshot", "snapshot_id", "created", "transaction", "generation"]) expect(key in result).toBe(false);
});
