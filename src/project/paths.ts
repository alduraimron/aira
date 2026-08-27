import path from "node:path";

export interface AiraProjectPaths {
  root: string;
  airaDir: string;
  configFile: string;
  workflowsDir: string;
  commandsDir: string;
  runsDir: string;
}

export function getAiraProjectPaths(root: string): AiraProjectPaths {
  const resolvedRoot = path.resolve(root);
  const airaDir = path.join(resolvedRoot, ".aira");

  return {
    root: resolvedRoot,
    airaDir,
    configFile: path.join(airaDir, "config.yaml"),
    workflowsDir: path.join(airaDir, "workflows"),
    commandsDir: path.join(airaDir, "commands"),
    runsDir: path.join(airaDir, "runs"),
  };
}
