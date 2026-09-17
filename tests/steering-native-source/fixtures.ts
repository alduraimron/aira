import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { SteeringSourceMetadata } from "../../src/steering-source";

export const encoder = new TextEncoder();

export const digest = (digit = 1): string => `sha256:${digit.toString(16).padStart(64, "0")}`;

export function sourceRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule.architecture.repository-access",
    title: "Use repository boundaries",
    authority: "normative",
    semantics: {
      key: "topic.architecture.data-access",
      effect: "require",
      value: "repository-layer",
    },
    override_policy: "narrower-scope",
    status: "active",
    rationale: "Keep transport and persistence boundaries separate.",
    enforcement: [],
    source: { location: { kind: "document" } },
    ...overrides,
  };
}

export function sourceMetadata(overrides: Record<string, unknown> = {}): SteeringSourceMetadata {
  return {
    schema: "aira.dev/steering-source/v1",
    id: "steering.architecture" as never,
    kind: "architecture",
    layer: "project-root",
    provenance: { authorship: "authored" },
    authority: "normative",
    override_policy: "narrower-scope",
    enforcement: [],
    inclusion: { availability: "required", selector: { kind: "always" } },
    scope: { kind: "project-global" },
    rules: [sourceRule()] as never,
    composition: { parents: [], overrides: [] },
    compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: [] },
    title: "Architecture constitution",
    labels: ["architecture"],
    behavioral_assets: [],
    ...overrides,
  } as SteeringSourceMetadata;
}

export function sourceBytes(
  metadata: SteeringSourceMetadata | Record<string, unknown> = sourceMetadata(),
  body = "# Architecture\n\nProject architecture guidance.\n",
  delimiterEol: "\n" | "\r\n" = "\n",
): Uint8Array {
  const yaml = stringify({ aira: metadata }, { lineWidth: 0 }).replaceAll("\n", delimiterEol);
  return encoder.encode(`---${delimiterEol}${yaml}---${delimiterEol}${body}`);
}

export async function temporaryProject(): Promise<{
  readonly root: string;
  readonly steering: string;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "aira-steering-source-"));
  const steering = join(root, ".aira", "steering");
  await mkdir(steering, { recursive: true });
  return { root, steering, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function putSource(
  steeringRoot: string,
  path: string,
  metadata: SteeringSourceMetadata | Record<string, unknown> = sourceMetadata(),
  body?: string,
): Promise<string> {
  const absolute = join(steeringRoot, ...path.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, sourceBytes(metadata, body));
  return absolute;
}
