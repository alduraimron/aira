import { z } from "zod";

export const specKindSchema = z.enum(["feature", "bugfix", "refactor", "migration", "custom"]);
export type SpecKind = z.infer<typeof specKindSchema>;
