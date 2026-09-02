export type TemplateContextValues = Readonly<Record<string, unknown>>;

export interface TemplateContext {
  readonly input: TemplateContextValues;
  readonly config: TemplateContextValues;
  readonly artifacts: TemplateContextValues;
  readonly revision: TemplateContextValues;
  readonly steps: TemplateContextValues;
  readonly run?: TemplateContextValues;
}
