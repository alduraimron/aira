import { randomBytes } from "node:crypto";

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{8}$/;

export function generateRunId(now: Date = new Date()): string {
  const timestamp = formatRunTimestamp(now);
  const suffix = randomBytes(4).toString("hex");
  return `${timestamp}-${suffix}`;
}

function formatRunTimestamp(now: Date): string {
  const time = now.getTime();

  if (!Number.isFinite(time)) {
    throw new RangeError("run ID timestamp must be a valid date");
  }

  const isoTimestamp = now.toISOString();

  if (!/^\d{4}-/.test(isoTimestamp)) {
    throw new RangeError("run ID timestamp year must use four digits");
  }

  return isoTimestamp
    .slice(0, 19)
    .replaceAll("-", "")
    .replace("T", "-")
    .replaceAll(":", "");
}
