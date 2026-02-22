export const AGENT_COLOR_SLOTS = [
  "#6b82a8", // slate blue
  "#5a8a72", // sage green
  "#8a6070", // dusty rose
  "#8a7454", // muted amber
  "#607080", // steel
];

export function agentColorForSlot(i: number): string {
  return AGENT_COLOR_SLOTS[i % AGENT_COLOR_SLOTS.length];
}

export function applyTheme(mode: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", mode);
}
