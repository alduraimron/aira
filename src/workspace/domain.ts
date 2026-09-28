import type { z } from "zod";
import { stableIssues, type DomainIssue, type DomainResult, type DeepReadonly } from "../spec/domain/primitives";

const codes = new Set([
  "workspace-id-invalid", "workspace-incarnation-invalid", "workspace-provider-incompatible",
  "workspace-topology-incompatible", "workspace-source-invalid", "workspace-dirty-policy-invalid",
  "workspace-fingerprint-invalid", "workspace-manifest-duplicate-path", "workspace-manifest-order-invalid", "workspace-manifest-path-invalid",
  "workspace-fingerprint-policy-mismatch", "workspace-fingerprint-workspace-mismatch",
  "workspace-fingerprint-incarnation-mismatch", "workspace-fingerprint-base-mismatch",
  "workspace-source-observation-mismatch", "workspace-schema-unsupported",
]);
export class WorkspaceDomainError extends Error {
  readonly code: string;
  constructor(readonly issues: readonly DomainIssue[]) {
    super(issues.map((issue) => `${issue.code}${issue.subject ? `: ${issue.subject}` : ""}`).join("; "));
    this.name = "WorkspaceDomainError";
    this.code = issues[0]?.code ?? "workspace-fingerprint-invalid";
  }
}
export function workspaceIssues(error: z.ZodError, fallback: string): DomainIssue[] {
  return stableIssues(error.issues.map((issue) => {
    const subject = issue.path.map(String).join(".");
    const code = codes.has(issue.message) ? issue.message :
      subject === "schema" ? "workspace-schema-unsupported" :
      subject === "id" || subject === "workspace_id" ? "workspace-id-invalid" :
      subject === "incarnation" ? "workspace-incarnation-invalid" :
      subject.startsWith("roots.") || subject === "topology" ? "workspace-topology-incompatible" :
      subject.startsWith("entries.") && subject.endsWith(".path") ? "workspace-manifest-path-invalid" : fallback;
    return { code, ...(subject ? { subject } : {}) };
  }));
}
export function checked<T>(schema: z.ZodType<T>, input: unknown, fallback: string): DomainResult<DeepReadonly<T>> {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: freeze(parsed.data) } :
    { ok: false, issues: workspaceIssues(parsed.error, fallback) };
}
export function required<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new WorkspaceDomainError(result.issues);
  return result.value;
}
/** Called only after strict parsing has detached plain JSON data from the caller. */
export function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
