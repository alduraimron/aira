export interface AiraConfigDefaults {
  model?: string;
  agent_timeout?: number;
  shell_timeout?: number;
  technical_retries?: number;
}

export interface AiraConfig {
  models?: Record<string, string>;
  defaults?: AiraConfigDefaults;
  commands?: Record<string, string>;
}
