import type { CliIO } from "./io";

export type SigintHandler = () => void;

export interface SigintSource {
  add(handler: SigintHandler): void;
  remove(handler: SigintHandler): void;
}

export const processSigintSource: SigintSource = {
  add(handler) {
    process.on("SIGINT", handler);
  },
  remove(handler) {
    process.off("SIGINT", handler);
  },
};

export async function withSigintAbort<T>(params: {
  io: CliIO;
  source: SigintSource;
  execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  let requested = false;
  const handler = () => {
    if (requested) {
      return;
    }

    requested = true;
    params.io.writeError("Interrupting current step...\n");
    controller.abort();
  };

  params.source.add(handler);

  try {
    return await params.execute(controller.signal);
  } finally {
    params.source.remove(handler);
  }
}
