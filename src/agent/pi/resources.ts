import {
  DefaultResourceLoader,
  getAgentDir,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface CreateAiraResourceLoaderOptions {
  cwd: string;
  settingsManager: SettingsManager;
  agentDir?: string;
}

/** Build Pi resources without loading instructions outside Aira's control. */
export async function createAiraResourceLoader(
  options: CreateAiraResourceLoaderOptions,
): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    settingsManager: options.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });

  await resourceLoader.reload();
  return resourceLoader;
}
