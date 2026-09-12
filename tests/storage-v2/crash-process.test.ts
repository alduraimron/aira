import { afterEach, expect, test } from "bun:test";
import { creation, created, temporary, mutation, withRequirements } from "./fixtures";
import { launch, requestFile } from "./processes";
import type { Failpoint } from "../../src/storage/file/fsync";
import { inspectStorage } from "../../src/storage/file/recovery";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
const boundaries: Failpoint[] = ["after-lock-acquisition", "after-blob-publication", "after-commit-publication", "after-head-temp-write",
  "after-head-temp-fsync", "before-head-rename", "after-head-rename", "after-head-directory-fsync", "before-lock-release"];
const published = (b: Failpoint) => ["after-head-rename", "after-head-directory-fsync", "before-lock-release"].includes(b);

for (const boundary of boundaries) {
  test(`SIGKILL mutation at ${boundary}: only old/new aggregate, fresh-process recovery`, async () => {
    const x = await created(); clean.push(x.cleanup);
    const request = withRequirements(mutation(x.result));
    const path = await requestFile(x.root, request.transaction, request.blobs);
    const killed = await launch(x.root, "commit", path, boundary).done(); expect(killed.exit).not.toBe(0);
    const read = await launch(x.root, "inspect", x.result.spec_id).done(); expect(read.last?.ok).toBe(true);
    expect(read.last?.state).toEqual(published(boundary) ? request.transaction.state : x.result.state);
    // Reads never steal the dead owner's lock.
    expect(await x.store.locks.owner(x.result.spec_id)).not.toBeNull();
    const recover = await launch(x.root, "recover", x.result.spec_id).done(); expect(recover.last?.recovered).toBe(true);
    const retry = await launch(x.root, "commit", path).done(); expect(retry.last?.ok).toBe(true);
    expect((retry.last?.result as { replayed: boolean }).replayed).toBe(published(boundary));
    expect((await x.store.verifySpecHistory(x.result.spec_id)).commits).toBe(2);
    const inspect = await inspectStorage(x.store);
    expect(inspect.entries.some((e) => e.kind === "lock" && e.classification === "temporary")).toBe(true);
    if (["after-commit-publication", "after-head-temp-write", "after-head-temp-fsync", "before-head-rename"].includes(boundary))
      expect(inspect.entries.some((e) => e.kind === "commit" && e.classification === "orphaned")).toBe(true);
  }, 30000);
  test(`SIGKILL genesis at ${boundary}: HEAD alone determines existence`, async () => {
    const x = await temporary(); clean.push(x.cleanup); const request = creation();
    const path = await requestFile(x.root, request.transaction, request.blobs);
    expect((await launch(x.root, "commit", path, boundary).done()).exit).not.toBe(0);
    const read = await launch(x.root, "inspect", request.transaction.spec_id).done();
    expect(read.last?.ok).toBe(published(boundary));
    if (!published(boundary)) expect(read.last?.code).toBe("STORE_NOT_FOUND");
    expect((await launch(x.root, "recover", request.transaction.spec_id).done()).last?.recovered).toBe(true);
    const retry = await launch(x.root, "commit", path).done(); expect(retry.last?.ok).toBe(true);
    expect((retry.last?.result as { replayed: boolean }).replayed).toBe(published(boundary));
    expect((await x.store.verifySpecHistory(request.transaction.spec_id)).commits).toBe(1);
  }, 30000);
}
