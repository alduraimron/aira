import type { AiraConfig } from "../config/types";
import type { TemplateContext } from "../context/types";
import type { RunState } from "../run/types";

export interface ExecutionContextInput {
  config: AiraConfig;
  artifacts?: Record<string, unknown>;
}

export function createExecutionTemplateContext(
  state: RunState,
  context: ExecutionContextInput,
): TemplateContext {
  return {
    input: state.input,
    config: { ...context.config },
    artifacts: context.artifacts ?? {},
    steps: state.steps,
    run: {
      id: state.id,
      workflow: state.workflow,
      status: state.status,
    },
  };
}
