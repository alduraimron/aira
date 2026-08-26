import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { AiraSessionEventRecord } from "./events";

export interface SessionAuditLog {
  record(record: AiraSessionEventRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type SessionAuditLogFactory = (
  filePath: string,
) => Promise<SessionAuditLog>;

class JsonlSessionAuditLog implements SessionAuditLog {
  private readonly file: FileHandle;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;

  constructor(file: FileHandle) {
    this.file = file;
  }

  record(record: AiraSessionEventRecord): void {
    if (this.closed) {
      this.failure ??= new Error("session audit log is already closed");
      return;
    }

    let line: string;

    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (cause) {
      this.failure ??= cause;
      return;
    }

    this.pending = this.pending.then(async () => {
      if (this.failure !== undefined) {
        return;
      }

      try {
        await this.file.appendFile(line, "utf8");
      } catch (cause) {
        this.failure ??= cause;
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;

    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.flush();
      return;
    }

    this.closed = true;
    let failure: unknown;

    try {
      await this.flush();
    } catch (cause) {
      failure = cause;
    }

    try {
      await this.file.close();
    } catch (cause) {
      failure ??= cause;
    }

    if (failure !== undefined) {
      throw failure;
    }
  }
}

export async function createSessionAuditLog(
  filePath: string,
): Promise<SessionAuditLog> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const file = await open(filePath, "w");
  return new JsonlSessionAuditLog(file);
}
