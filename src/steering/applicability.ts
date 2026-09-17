import { z } from "zod";
import { deterministicGlobSchema, pathSelectorSchema, type PathSelector } from "../context/declarations";
import { specKindSchema } from "../spec/domain/kinds";
import { canonical, compareText, nonBlankSchema } from "../spec/domain/primitives";
import { taskKindSchema } from "../tasks/schema";

export const steeringPhases = [
  "intent",
  "product",
  "requirements",
  "architecture",
  "program-design",
  "slice-planning",
  "task-planning",
  "implementation",
  "verification",
  "review",
] as const;
export const steeringPhaseSchema = z.enum(steeringPhases);

const canonicalValues = (values: readonly unknown[]): boolean => values.every((value, index) =>
  index === 0 || compareText(canonical(values[index - 1]), canonical(value)) < 0);
const orderedEnumValues = <T extends string>(values: readonly T[], order: readonly T[]): boolean => values.every((value, index) =>
  order.includes(value) && (index === 0 || order.indexOf(values[index - 1]!) < order.indexOf(value)));

export const steeringSpecKindSelectorSchema = z.strictObject({
  kind: specKindSchema,
  custom_kind: nonBlankSchema.optional(),
}).refine((value) => (value.kind === "custom") === (value.custom_kind !== undefined), "invalid-steering-spec-kind-selector");

export const steeringTaskKindSelectorSchema = z.strictObject({
  kind: taskKindSchema,
  custom_kind: nonBlankSchema.optional(),
}).refine((value) => (value.kind === "custom") === (value.custom_kind !== undefined), "invalid-steering-task-kind-selector");

const phaseSetSchema = z.array(steeringPhaseSchema).min(1)
  .refine((values) => orderedEnumValues(values, steeringPhases), "noncanonical-steering-phase-set");
const pathSetSchema = z.array(pathSelectorSchema).min(1)
  .refine(canonicalValues, "noncanonical-steering-path-set");
const specKindSetSchema = z.array(steeringSpecKindSelectorSchema).min(1)
  .refine(canonicalValues, "noncanonical-steering-spec-kind-set");
const taskKindSetSchema = z.array(steeringTaskKindSelectorSchema).min(1)
  .refine(canonicalValues, "noncanonical-steering-task-kind-set");

export type SteeringSpecKindSelectorValue = z.infer<typeof steeringSpecKindSelectorSchema>;
export type SteeringTaskKindSelectorValue = z.infer<typeof steeringTaskKindSelectorSchema>;
export type SteeringPhaseValue = z.infer<typeof steeringPhaseSchema>;

type InclusionAtomic =
  | { kind: "always" }
  | { kind: "phase"; phases: SteeringPhaseValue[] }
  | { kind: "path"; selectors: PathSelector[] }
  | { kind: "spec-kind"; kinds: SteeringSpecKindSelectorValue[] }
  | { kind: "task-kind"; kinds: SteeringTaskKindSelectorValue[] }
  | { kind: "manual" };
export type SteeringInclusionSelectorValue = InclusionAtomic | {
  kind: "composite";
  operator: "and" | "or";
  selectors: SteeringInclusionSelectorValue[];
};

export const steeringInclusionSelectorSchema: z.ZodType<SteeringInclusionSelectorValue> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({ kind: z.literal("phase"), phases: phaseSetSchema }),
  z.strictObject({ kind: z.literal("path"), selectors: pathSetSchema }),
  z.strictObject({ kind: z.literal("spec-kind"), kinds: specKindSetSchema }),
  z.strictObject({ kind: z.literal("task-kind"), kinds: taskKindSetSchema }),
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("composite"),
    operator: z.enum(["and", "or"]),
    selectors: z.array(steeringInclusionSelectorSchema).min(2),
  }).superRefine((value, ctx) => {
    if (!canonicalValues(value.selectors)) ctx.addIssue({ code: "custom", message: "noncanonical-steering-inclusion-composite" });
    if (value.selectors.some((selector) => selector.kind === "always" ||
      (selector.kind === "composite" && selector.operator === value.operator)))
      ctx.addIssue({ code: "custom", message: "noncanonical-steering-inclusion-composition" });
  }),
]));

export const steeringInclusionSchema = z.strictObject({
  availability: z.enum(["required", "optional"]),
  selector: steeringInclusionSelectorSchema,
});

type ScopeAtomic =
  | { kind: "project-global" }
  | { kind: "path"; selectors: PathSelector[] }
  | { kind: "phase"; phases: SteeringPhaseValue[] }
  | { kind: "spec-kind"; kinds: SteeringSpecKindSelectorValue[] }
  | { kind: "task-kind"; kinds: SteeringTaskKindSelectorValue[] };
export type SteeringScopeValue = ScopeAtomic | {
  kind: "composite";
  operator: "and" | "or";
  scopes: SteeringScopeValue[];
};

export const steeringScopeSchema: z.ZodType<SteeringScopeValue> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal("project-global") }),
  z.strictObject({ kind: z.literal("path"), selectors: pathSetSchema }),
  z.strictObject({ kind: z.literal("phase"), phases: phaseSetSchema }),
  z.strictObject({ kind: z.literal("spec-kind"), kinds: specKindSetSchema }),
  z.strictObject({ kind: z.literal("task-kind"), kinds: taskKindSetSchema }),
  z.strictObject({
    kind: z.literal("composite"),
    operator: z.enum(["and", "or"]),
    scopes: z.array(steeringScopeSchema).min(2),
  }).superRefine((value, ctx) => {
    if (!canonicalValues(value.scopes)) ctx.addIssue({ code: "custom", message: "noncanonical-steering-scope-composite" });
    if (value.scopes.some((scope) => scope.kind === "project-global" ||
      (scope.kind === "composite" && scope.operator === value.operator)))
      ctx.addIssue({ code: "custom", message: "noncanonical-steering-scope-composition" });
  }),
]));

/** Re-exported identity for callers authoring path selectors without importing Context. */
export const steeringGlobPatternSchema = deterministicGlobSchema;

export const canonicalSteeringSelectors = <T>(values: readonly T[]): T[] =>
  [...values].sort((left, right) => compareText(canonical(left), canonical(right)));

export const canonicalSteeringPhases = (values: readonly SteeringPhaseValue[]): SteeringPhaseValue[] =>
  [...new Set(values)].sort((left, right) => steeringPhases.indexOf(left) - steeringPhases.indexOf(right));

export const canonicalSteeringSpecKinds = (values: readonly SteeringSpecKindSelectorValue[]): SteeringSpecKindSelectorValue[] =>
  canonicalSteeringSelectors(values);

export const canonicalSteeringTaskKinds = (values: readonly SteeringTaskKindSelectorValue[]): SteeringTaskKindSelectorValue[] =>
  canonicalSteeringSelectors(values);

