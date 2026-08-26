export interface CommandMetadata {
  description?: string;
  model?: string;
  thinking?: string;
  timeout?: number;
  retry?: number;
  tools?: string[];
}

export interface ParsedCommandMarkdown {
  metadata: CommandMetadata;
  prompt: string;
}

export interface AgentCommand extends ParsedCommandMarkdown {
  name: string;
  filePath: string;
}
