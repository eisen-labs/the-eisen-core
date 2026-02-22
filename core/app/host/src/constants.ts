export type SessionMode = "single_agent" | "orchestrator";

export const SELECTED_AGENT_KEY = "eisen.selectedAgent";
export const SELECTED_MODE_KEY = "eisen.selectedMode";
export const SELECTED_MODEL_KEY = "eisen.selectedModel";

export const MAX_AGENT_INSTANCES = 10;

export const AGENT_SHORT_NAMES: Record<string, string> = {
  opencode: "op",
  "claude-code": "cl",
  codex: "cx",
  gemini: "ge",
  goose: "go",
  amp: "am",
  aider: "ai",
};

export function agentShortName(agentType: string): string {
  return AGENT_SHORT_NAMES[agentType] ?? agentType.slice(0, 2);
}

export interface InstanceInfo {
  key: string;
  label: string;
  agentType: string;
  color: string;
  connected: boolean;
  isStreaming: boolean;
}
