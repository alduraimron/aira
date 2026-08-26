import { z } from "zod";

import {
  ARTIFACT_NAME_PATTERN,
  isSafeStoredArtifactPath,
} from "../artifacts/paths";
import { RUN_ID_PATTERN } from "./id";
import {
  RUN_STATUSES,
  STEP_STATUSES,
  type ArtifactState,
  type RunState,
  type StepState,
} from "./types";

const ISO_UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

export const isoTimestampSchema = z.string().refine(isValidIsoUtcTimestamp, {
  message: "timestamp must be a valid ISO 8601 UTC string",
});

export const runStatusSchema = z.enum(RUN_STATUSES);
export const stepStatusSchema = z.enum(STEP_STATUSES);

export const stepStateSchema: z.ZodType<StepState> = z.strictObject({
  status: stepStatusSchema,
  attempt: z.number().int().nonnegative(),
  started_at: isoTimestampSchema.optional(),
  completed_at: isoTimestampSchema.optional(),
  success: z.boolean().optional(),
  exit_code: z.number().int().optional(),
  summary: z.string().optional(),
  result: z.string().optional(),
  artifact: z.string().optional(),
  output: z.string().optional(),
});

const storedArtifactPathSchema = z.string().refine(isSafeStoredArtifactPath, {
  message: 'artifact path must be a normalized path inside "artifacts/"',
});

export const artifactStateSchema: z.ZodType<ArtifactState> = z
  .strictObject({
    current: storedArtifactPathSchema,
    versions: z.array(storedArtifactPathSchema).min(1).optional(),
  })
  .superRefine((artifact, context) => {
    if (artifact.versions === undefined) {
      return;
    }

    const lastVersion = artifact.versions.at(-1);

    if (lastVersion !== undefined && artifact.current !== lastVersion) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "current artifact path must equal the last version path",
      });
    }

    const firstIndexes = new Map<string, number>();

    for (const [index, version] of artifact.versions.entries()) {
      const firstIndex = firstIndexes.get(version);

      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["versions", index],
          message:
            `duplicate artifact version path "${version}"; first used at ` +
            `versions[${firstIndex}]`,
        });
      } else {
        firstIndexes.set(version, index);
      }
    }
  });

const artifactNameSchema = z.string().regex(ARTIFACT_NAME_PATTERN, {
  message: `artifact name must match ${ARTIFACT_NAME_PATTERN.source}`,
});

export const runStateSchema: z.ZodType<RunState> = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(RUN_ID_PATTERN, {
    message: `run ID must match ${RUN_ID_PATTERN.source}`,
  }),
  workflow: z.string(),
  status: runStatusSchema,
  input: z.record(z.string(), z.unknown()),
  current_step: z.string().optional(),
  started_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  steps: z.record(z.string(), stepStateSchema),
  artifacts: z.record(artifactNameSchema, artifactStateSchema),
});

function isValidIsoUtcTimestamp(value: string): boolean {
  const match = ISO_UTC_TIMESTAMP_PATTERN.exec(value);

  if (match === null || match[1] === undefined) {
    return false;
  }

  const milliseconds = (match[2] ?? "").padEnd(3, "0");
  const canonicalTimestamp = `${match[1]}.${milliseconds}Z`;
  const parsed = Date.parse(value);

  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === canonicalTimestamp
  );
}
