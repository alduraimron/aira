import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface CliIO {
  writeOut(message: string): void;
  writeError(message: string): void;
  /** Returns null when stdin closes or the optional signal aborts. */
  readLine(prompt: string, signal?: AbortSignal): Promise<string | null>;
}

export interface ClosableCliIO extends CliIO {
  close(): void;
}

export interface ProcessCliIOOptions {
  input?: Readable;
  output?: Writable;
  error?: Writable;
}

export function createProcessCliIO(
  options: ProcessCliIOOptions = {},
): ClosableCliIO {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  let readline: Interface | undefined;
  let closed = false;

  const getReadline = (): Interface | undefined => {
    if (closed) {
      return undefined;
    }

    readline ??= createInterface({ input, output });
    readline.once("close", () => {
      closed = true;
    });
    return readline;
  };

  return {
    writeOut(message) {
      output.write(message);
    },
    writeError(message) {
      error.write(message);
    },
    async readLine(prompt, signal) {
      if (signal?.aborted === true) {
        return null;
      }

      const current = getReadline();

      if (current === undefined) {
        return null;
      }

      return await new Promise<string | null>((resolve) => {
        let settled = false;

        const settle = (value: string | null) => {
          if (settled) {
            return;
          }

          settled = true;
          current.removeListener("close", handleClose);
          signal?.removeEventListener("abort", handleAbort);
          resolve(value);
        };
        const handleClose = () => settle(null);
        const handleAbort = () => settle(null);
        current.once("close", handleClose);
        signal?.addEventListener("abort", handleAbort, { once: true });

        if (signal?.aborted === true) {
          handleAbort();
          return;
        }

        try {
          current.question(prompt, (answer) => settle(answer));
        } catch {
          settle(null);
        }
      });
    },
    close() {
      closed = true;
      readline?.close();
    },
  };
}
