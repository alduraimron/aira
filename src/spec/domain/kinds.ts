import { z } from "zod";

export const specKinds = ["feature", "bugfix", "refactor", "migration", "custom"] as const;
export const specKindSchema = z.enum(specKinds);
export type SpecKind = z.infer<typeof specKindSchema>;
