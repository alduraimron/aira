import { z } from "zod";
import { contextDeclarationIdSchema, taskIdSchema } from "../spec/domain/ids";
import { nonBlankSchema, safeUnsignedSchema, unique, type DeepReadonly } from "../spec/domain/primitives";

// Portable, workspace-relative declaration syntax. This is not resolved-path enforcement.
export const logicalPathSchema = nonBlankSchema.refine((p) => !p.startsWith("/") && !p.includes("\\") &&
  !p.includes(":") && !/[\u0000-\u001f\u007f]/.test(p) && p.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "invalid-logical-path");
export const exactPathSchema = logicalPathSchema.refine((p) => !/[\*?\[\]{}]/.test(p), "wildcard-in-exact-path");
export const deterministicGlobSchema = logicalPathSchema.refine((p) => !/[\[\]{}]/.test(p) &&
  p.split("/").every((part) => !part.includes("**") || part === "**"), "unsupported-glob-syntax");
export const pathSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact"), path: exactPathSchema }),
  z.strictObject({ kind: z.literal("tree"), path: exactPathSchema }),
  z.strictObject({ kind: z.literal("glob"), pattern: deterministicGlobSchema, dialect: z.literal("aira.dev/glob/v1") }),
]);
export const contextPhaseSchema = z.enum(["intent", "product", "requirements", "analysis", "architecture", "program-design", "slice-plan", "tasks", "implementation", "verification", "revision"]);
export const contextDeclarationSchema = z.strictObject({
  schema: z.literal("aira.dev/context-declaration/v2"), id: contextDeclarationIdSchema,
  selector: pathSelectorSchema, required: z.boolean(), phases: z.array(contextPhaseSchema).min(1),
  tasks: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("all") }),
    z.strictObject({ kind: z.literal("selected"), ids: z.array(taskIdSchema).min(1).refine(unique) })]),
  max_bytes: safeUnsignedSchema.refine((n) => n > 0),
  inclusion: z.enum(["inline", "reference", "summary"]),
  classification: z.enum(["public", "internal", "confidential", "secret", "untrusted"]),
}).refine((d) => unique(d.phases), "duplicate-context-phase");
export type ContextDeclaration = DeepReadonly<z.infer<typeof contextDeclarationSchema>>;
export type PathSelector = z.infer<typeof pathSelectorSchema>;
/** Fixed grammar: *, ? match one segment; ** matches zero or more complete segments. */
export function matchesPath(selector: PathSelector, path: string): boolean {
  if (!exactPathSchema.safeParse(path).success) return false;
  if (selector.kind === "exact") return selector.path === path;
  if (selector.kind === "tree") return selector.path === path || path.startsWith(`${selector.path}/`);
  const pattern = selector.pattern.split("/"), segments = path.split("/");
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (i === pattern.length) result = j === segments.length;
    else if (pattern[i] === "**") result = match(i + 1, j) || (j < segments.length && match(i, j + 1));
    else {
      const expression = pattern[i]!.split("").map((c) => c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
      result = j < segments.length && new RegExp(`^${expression}$`).test(segments[j]!) && match(i + 1, j + 1);
    }
    memo.set(key, result); return result;
  };
  return match(0, 0);
}
