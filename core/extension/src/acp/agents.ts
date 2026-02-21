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
  console.log(`[Eisen] Default agent selected: ${agent.name} (${agent.command})`);
  return agent;
}

function isCommandAvailableAsync(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    execFile(whichCmd, [command], { encoding: "utf8", timeout: 2000 }, (error, stdout) => {
      if (error) {
        console.log(`[Eisen] Command "${command}" not available:`, error.message);
        resolve(false);
        return;
      }
      const isAvailable = stdout.trim().length > 0;
      console.log(`[Eisen] Command "${command}" available:`, isAvailable, stdout.trim().split("\n")[0]);
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
  const uniqueCommands = [...new Set(AGENTS.map((a) => a.command))];
  const availability = new Map<string, boolean>();
  await Promise.all(
    uniqueCommands.map(async (cmd) => {
      availability.set(cmd, await isCommandAvailableAsync(cmd));
    }),
  );
  const results = AGENTS.map((agent) => ({
    ...agent,
    available: availability.get(agent.command) ?? false,
  }));
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
  console.log("[Eisen] Agent availability:", agents.map((a) => `${a.name}: ${a.available}`).join(", "));
  const available = agents.find((a) => a.available);
  if (!available) {
    console.log("[Eisen] No agents available, falling back to opencode");
    // Return opencode as fallback, but the caller should check isAgentAvailable first
    return AGENTS[0];
  }
  console.log(`[Eisen] First available agent: ${available.name}`);
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
