import {
  resolveCliModel,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type ResolveCliModelResult,
} from "@earendil-works/pi-coding-agent";

export type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;
export type PiThinkingLevel = NonNullable<
  CreateAgentSessionOptions["thinkingLevel"]
>;

/**
 * The SDK exports the ThinkingLevel type through its session options, but it
 * does not export a runtime validator or values array.
 */
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly PiThinkingLevel[];

const piThinkingLevelSet = new Set<string>(PI_THINKING_LEVELS);

export type PiModelResolver = (
  selector: string,
  modelRuntime: ModelRuntime,
  thinkingLevel?: PiThinkingLevel,
) => ResolveCliModelResult;

export const resolvePiModel: PiModelResolver = (
  selector,
  modelRuntime,
  thinkingLevel,
) =>
  resolveCliModel({
    cliModel: selector,
    cliThinking: thinkingLevel,
    modelRuntime,
  });

export function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return piThinkingLevelSet.has(value);
}

export function formatPiThinkingLevels(): string {
  return PI_THINKING_LEVELS.join(", ");
}
