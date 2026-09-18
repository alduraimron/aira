import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const encoder = new TextEncoder();

export async function temporaryAgentsProject(): Promise<{
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "aira-steering-agents-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function putAgents(root: string, sourcePath: string, body: string | Uint8Array): Promise<string> {
  const absolute = join(root, ...sourcePath.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, typeof body === "string" ? encoder.encode(body) : body);
  return absolute;
}

export function codeList(value: { readonly diagnostics: readonly { readonly code: string }[] }): string[] {
  return value.diagnostics.map((diagnostic) => diagnostic.code);
}
