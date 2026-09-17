import { readFile, stat } from "node:fs/promises";
import { FileSteeringStore } from "../../src/storage/file/steering-store";
import { FileSteeringSnapshotStore } from "../../src/storage/file/steering-snapshot-store";
import { steeringTransactionSchema } from "../../src/storage/steering-types";
import { steeringSnapshotPublicationMetadataSchema } from "../../src/storage/steering-snapshot-types";
import { steeringResourceRevisionSchema, steeringProjectNamespaceSchema } from "../../src/steering/schema";
import { steeringSnapshotIdSchema } from "../../src/steering/ids";
import { steeringSnapshotSchema } from "../../src/steering/snapshot";
import { contentHashSchema } from "../../src/spec/domain/primitives";
import type { Failpoint } from "../../src/storage/file/fsync";

const [root, mode, argument, boundary = "", gate = ""] = process.argv.slice(2);
if (!root || !mode || !argument) throw new Error("worker arguments required");
async function waitFor(path: string) {
  const until = performance.now() + 15_000;
  for (;;) {
    try { await stat(path); return; }
    catch { if (performance.now() > until) throw new Error("barrier timed out"); await Bun.sleep(5); }
  }
}
const options = { lockTimeoutMs: 2_000, failpoint: async (point: Failpoint) => {
  if (boundary === point) process.kill(process.pid, "SIGKILL");
  if ((boundary === "hold" && point === "after-lock-acquisition") ||
    (boundary === "hold-snapshot" && point === "after-snapshot-source-verification")) {
    console.log(JSON.stringify({ held: true }));
    await waitFor(gate);
  }
} };
const store = new FileSteeringStore(root, options);
const snapshotStore = new FileSteeringSnapshotStore(root, options);

try {
  if (mode === "inspect") {
    const project = steeringProjectNamespaceSchema.parse(argument);
    const state = await store.loadRegistry(project, "deep");
    console.log(JSON.stringify({ ok: true, head: state.head, registry: state.registry }));
  } else if (mode === "snapshot-inspect") {
    const snapshot = await snapshotStore.getSnapshot(steeringSnapshotIdSchema.parse(argument));
    console.log(JSON.stringify({ ok: true, snapshot }));
  } else if (mode === "recover") {
    const project = steeringProjectNamespaceSchema.parse(argument);
    console.log(JSON.stringify({ ok: true, recovered: await store.recoverLock(project) }));
  } else if (mode === "lock-die") {
    const project = steeringProjectNamespaceSchema.parse(argument);
    await store.locks.acquire(project);
    process.kill(process.pid, "SIGKILL");
  } else if (mode === "snapshot-put" || mode === "snapshot-race") {
    const request = JSON.parse(await readFile(argument, "utf8")) as { snapshot: unknown; metadata: unknown };
    if (mode === "snapshot-race") { console.log(JSON.stringify({ ready: true })); await waitFor(gate); }
    const result = await snapshotStore.putSnapshot(
      steeringSnapshotSchema.parse(request.snapshot),
      steeringSnapshotPublicationMetadataSchema.parse(request.metadata),
    );
    console.log(JSON.stringify({ ok: true, result }));
  } else {
    const request = JSON.parse(await readFile(argument, "utf8")) as {
      transaction: unknown;
      revisions: { revision: unknown; hex: string }[];
      blobs: { hash: string; hex: string }[];
    };
    const transaction = steeringTransactionSchema.parse(request.transaction);
    if (mode === "race") { console.log(JSON.stringify({ ready: true })); await waitFor(gate); }
    const result = await store.commit(transaction,
      request.revisions.map((publication) => ({ revision: steeringResourceRevisionSchema.parse(publication.revision), body: Buffer.from(publication.hex, "hex") })),
      request.blobs.map((blob) => ({ hash: contentHashSchema.parse(blob.hash), bytes: Buffer.from(blob.hex, "hex") })));
    console.log(JSON.stringify({ ok: true, result }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false,
    code: error && typeof error === "object" && "code" in error ? error.code : "UNEXPECTED",
    message: String(error) }));
}
