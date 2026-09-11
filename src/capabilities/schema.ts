import { z } from "zod";
import { operationIdSchema, specIdSchema } from "../spec/domain/ids";
import { specGenerationSchema } from "../spec/domain/generations";
import { channelSchema, contentHashSchema, humanActorSchema, nonBlankSchema, policyReferenceSchema, profileReferenceSchema, timestampSchema, unique } from "../spec/domain/primitives";
import { pathSelectorSchema } from "../context/declarations";
import { backendCapabilitySchema } from "../workspace/schema";

export const toolIdentitySchema = z.strictObject({
  name: nonBlankSchema, provider: nonBlankSchema, implementation: nonBlankSchema, version: nonBlankSchema, integrity: contentHashSchema,
});
export const destinationSchema = z.strictObject({
  host: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  port: z.number().int().min(1).max(65535), protocol: z.enum(["tcp", "udp"]),
});
const pathRules = z.strictObject({ allow: z.array(pathSelectorSchema), deny: z.array(pathSelectorSchema) });
export const capabilityPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/capability-policy/v1"), identity: policyReferenceSchema,
  filesystem: z.strictObject({ read: pathRules, write: pathRules, create: pathRules, delete: pathRules }),
  protected_paths: z.array(pathSelectorSchema),
  process: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("deny") }),
    z.strictObject({ mode: z.literal("profiles"), profiles: z.array(profileReferenceSchema).min(1), arbitrary_shell: z.boolean() }),
    z.strictObject({ mode: z.literal("ask"), profiles: z.array(profileReferenceSchema).min(1), arbitrary_shell: z.boolean() }),
  ]),
  network: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("deny") }),
    z.strictObject({ mode: z.literal("allow-list"), destinations: z.array(destinationSchema), deny: z.array(destinationSchema) }),
    z.strictObject({ mode: z.literal("ask"), destinations: z.array(destinationSchema), deny: z.array(destinationSchema) }),
  ]),
  tools: z.strictObject({ allow: z.array(toolIdentitySchema), deny: z.array(z.union([toolIdentitySchema, z.strictObject({ name: nonBlankSchema })])) }),
  environment: z.strictObject({ allow: z.array(nonBlankSchema), deny: z.array(nonBlankSchema), inherit_ambient: z.boolean() }),
  required_backend: z.array(backendCapabilitySchema).refine(unique),
});
export const capabilityEscalationSchema = z.strictObject({
  schema: z.literal("aira.dev/capability-escalation/v1"), operation: operationIdSchema,
  actor: humanActorSchema, channel: channelSchema.optional(), spec_id: specIdSchema, generation: specGenerationSchema,
  policies: z.array(policyReferenceSchema).min(1),
  request: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("process"), profile: profileReferenceSchema, arbitrary_shell: z.boolean() }),
    z.strictObject({ kind: z.literal("network"), destination: destinationSchema }),
  ]),
  decision: z.enum(["allowed", "denied"]), reason: nonBlankSchema, at: timestampSchema,
});
export const effectiveCapabilityPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/effective-capability-policy/v1"),
  // Keep layers: unsafe approximations of glob/policy intersection are forbidden.
  layers: z.array(capabilityPolicySchema).min(1),
  required_backend: z.array(backendCapabilitySchema).refine(unique),
}).refine((p) => {
  const required = new Set(p.layers.flatMap((layer) => layer.required_backend));
  return p.required_backend.length === required.size && p.required_backend.every((r) => required.has(r));
}, "effective-backend-requirements-mismatch");
