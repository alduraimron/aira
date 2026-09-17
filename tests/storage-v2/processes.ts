import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BlobInput, StoreTransaction } from "../../src/storage/types";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./process-worker.ts", import.meta.url));
export async function requestFile(root: string, transaction: StoreTransaction, blobs: readonly BlobInput[] = []) {
  const path = join(root, `test-request-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ transaction, blobs: blobs.map((b) => ({ hash: b.hash, hex: Buffer.from(b.bytes).toString("hex") })) }));
  return path;
}
export function launchWorker(workerPath: string, root: string, mode: string, argument: string, boundary = "", gate = "") {
  const process = Bun.spawn([Bun.which("bun")!, workerPath, root, mode, argument, boundary, gate], { stdout: "pipe", stderr: "pipe" });
  const lines: Record<string, unknown>[] = [];
  const output = (async () => {
    let text = "";
    for await (const chunk of process.stdout) {
      text += new TextDecoder().decode(chunk);
      let index;
      while ((index = text.indexOf("\n")) !== -1) {
        const line = text.slice(0, index); text = text.slice(index + 1);
        if (line.trim()) lines.push(JSON.parse(line));
      }
    }
  })();
  return { process, lines,
    async until(key: string) {
      const until = performance.now() + 10000;
      while (!lines.some((line) => line[key])) {
        if (performance.now() > until || process.exitCode !== null) throw Error(`Child did not signal ${key}: ${JSON.stringify(lines)}`);
        await Bun.sleep(5);
      }
    },
    async done() {
      const exit = await process.exited; await output;
      const stderr = await new Response(process.stderr).text();
      if (stderr) throw Error(`Worker stderr: ${stderr}`);
      return { exit, lines, last: lines.at(-1) };
    },
  };
}

export function launch(root: string, mode: string, argument: string, boundary = "", gate = "") {
  return launchWorker(worker, root, mode, argument, boundary, gate);
}
