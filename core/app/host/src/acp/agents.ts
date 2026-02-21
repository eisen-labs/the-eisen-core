import { execFile } from "node:child_process";

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export const AGENTS: AgentConfig[] = [
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["@zed-industries/claude-code-acp"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "npx",
    args: ["@zed-industries/codex-acp"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose",
    args: ["acp"],
  },
  {
    id: "amp",
    name: "Amp",
    command: "amp",
    args: ["acp"],
  },
  {
    id: "aider",
    name: "Aider",
    command: "aider",
    args: ["--acp"],
  },
];

export function getAgent(id: string): AgentConfig | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function getDefaultAgent(): AgentConfig {
  const agent = getFirstAvailableAgent();
  console.error(`[Eisen] Default agent selected: ${agent.name} (${agent.command})`);
  return agent;
}

function isCommandAvailableAsync(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    execFile(whichCmd, [command], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error(`[Eisen] Command "${command}" not available:`, error.message);
        resolve(false);
        return;
      }
      const isAvailable = stdout.trim().length > 0;
      console.error(`[Eisen] Command "${command}" available:`, isAvailable, stdout.trim().split("\n")[0]);
      resolve(isAvailable);
    });
  });
}

export interface AgentWithStatus extends AgentConfig {
  available: boolean;
}

let cachedAgentsWithStatus: AgentWithStatus[] | null = null;
let cachePromise: Promise<AgentWithStatus[]> | null = null;

export async function refreshAgentStatus(): Promise<AgentWithStatus[]> {
  const results = await Promise.all(
    AGENTS.map(async (agent) => ({
      ...agent,
      available: await isCommandAvailableAsync(agent.command),
    })),
  );
  cachedAgentsWithStatus = results;
  return results;
}

export function getAgentsWithStatus(forceRefresh = false): AgentWithStatus[] {
  if (cachedAgentsWithStatus && !forceRefresh) {
    return cachedAgentsWithStatus;
  }
  // Return cached or optimistic defaults (all unavailable) — caller should
  // await ensureAgentStatusLoaded() for accurate results.
  if (!cachedAgentsWithStatus) {
    return AGENTS.map((agent) => ({ ...agent, available: false }));
  }
  return cachedAgentsWithStatus;
}

/** Ensure agent availability has been probed at least once. Safe to call repeatedly. */
export async function ensureAgentStatusLoaded(): Promise<AgentWithStatus[]> {
  if (cachedAgentsWithStatus) return cachedAgentsWithStatus;
  if (!cachePromise) {
    cachePromise = refreshAgentStatus().finally(() => {
      cachePromise = null;
    });
  }
  return cachePromise;
}

export function getFirstAvailableAgent(): AgentConfig {
  const agents = getAgentsWithStatus();
  console.error("[Eisen] Agent availability:", agents.map((a) => `${a.name}: ${a.available}`).join(", "));
  const available = agents.find((a) => a.available);
  if (!available) {
    console.error("[Eisen] No agents available, falling back to opencode");
    // Return opencode as fallback, but the caller should check isAgentAvailable first
    return AGENTS[0];
  }
  console.error(`[Eisen] First available agent: ${available.name}`);
  return available;
}

export function hasAnyAvailableAgent(): boolean {
  const agents = getAgentsWithStatus();
  return agents.some((a) => a.available);
}

export function isAgentAvailable(agentId: string): boolean {
  const agents = getAgentsWithStatus();
  const agent = agents.find((a) => a.id === agentId);
  return agent?.available ?? false;
}
