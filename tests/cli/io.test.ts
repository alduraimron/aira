import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createProcessCliIO } from "../../src/cli";

describe("process CLI input", () => {
  test("an AbortSignal releases a pending approval read", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const io = createProcessCliIO({ input, output, error });
    const controller = new AbortController();
    const pending = io.readLine("> ", controller.signal);

    controller.abort();

    expect(await pending).toBeNull();
    io.close();
    input.destroy();
    output.destroy();
    error.destroy();
  });
});
