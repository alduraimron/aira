import { readFile, stat } from "node:fs/promises";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { transactionSchema } from "../../src/storage/types";
import { specIdSchema } from "../../src/spec/domain/ids";
import { contentHashSchema } from "../../src/spec/domain/primitives";
import type { Failpoint } from "../../src/storage/file/fsync";

const [root, mode, argument, boundary = "", gate = ""] = process.argv.slice(2);
if (!root || !mode || !argument) throw Error("worker arguments required");
async function waitFor(path: string) {
  const until = performance.now() + 15000;
  while (true) {
    try { await stat(path); return; } catch { if (performance.now() > until) throw Error("barrier timed out"); await Bun.sleep(5); }
  }
}
const store = new FileSpecStore(root, { lockTimeoutMs: 2000, failpoint: async (point: Failpoint) => {
  if (boundary === point) process.kill(process.pid, "SIGKILL");
  if (boundary === "hold" && point === "after-lock-acquisition") { console.log(JSON.stringify({ held: true })); await waitFor(gate); }
} });
try {
  if (mode === "inspect") {
    const state = await store.loadSpec(specIdSchema.parse(argument), "deep");
    console.log(JSON.stringify({ ok: true, head: state.head, state: state.state }));
  } else if (mode === "recover") {
    const recovered = await store.locks.recover(specIdSchema.parse(argument)); console.log(JSON.stringify({ ok: true, recovered }));
  } else if (mode === "lock-die") {
    await store.locks.acquire(specIdSchema.parse(argument)); process.kill(process.pid, "SIGKILL");
  } else {
    const request = JSON.parse(await readFile(argument, "utf8")) as { transaction: unknown; blobs: { hash: string; hex: string }[] };
    const t = transactionSchema.parse(request.transaction);
    if (mode === "race") { console.log(JSON.stringify({ ready: true })); await waitFor(gate); }
    const result = await store.commit(t, request.blobs.map((b) => ({ hash: contentHashSchema.parse(b.hash), bytes: Buffer.from(b.hex, "hex") })));
    console.log(JSON.stringify({ ok: true, result }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "UNEXPECTED", message: String(error) }));
}
