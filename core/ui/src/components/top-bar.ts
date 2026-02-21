import { el } from "../dom";
import { ICON } from "../panels/icons";
import type { AgentInfo } from "../state";

export interface TopBarCb {
  onSelect(id: string): void;
  onAdd(): void;
}

export class TopBar {
  el: HTMLElement;
  private strip: HTMLElement;
  private cb: TopBarCb;
  private tabs = new Map<string, HTMLElement>();
  private dots = new Map<string, HTMLElement>();
  private selected: string | null = null;
  private streaming = new Set<string>();
  private pending: HTMLElement | null = null;

  constructor(cb: TopBarCb) {
    this.cb = cb;
    this.strip = el("div", { className: "tab-strip" });
    const add = el("button", {
      type: "button",
      className: "add-btn",
      innerHTML: ICON.plus,
      "aria-label": "New chat",
    });
    add.addEventListener("click", () => cb.onAdd());
    this.el = el("div", { className: "top-bar" });
    this.el.append(this.strip, add);
  }

  apply(agents: AgentInfo[]): void {
    this.pending?.remove();
    this.pending = null;
    this.strip.innerHTML = "";
    this.tabs.clear();
    this.dots.clear();

    for (const a of agents) {
      const active = a.instanceId === this.selected;
      const tab = el("div", { className: active ? "tab active" : "tab" });
      const dot = el("div", {
        className: `tab-dot${a.connected ? "" : " dim"}`,
        style: { background: a.color },
      });
      tab.append(dot, el("span", { className: "tab-text" }, a.displayName));
      tab.addEventListener("click", () => this.select(a.instanceId));
      this.strip.append(tab);
      this.tabs.set(a.instanceId, tab);
      this.dots.set(a.instanceId, dot);
    }

    if (!this.selected && agents.length > 0) this.select(agents[0].instanceId);
    if (this.selected && !agents.some((a) => a.instanceId === this.selected)) {
      if (agents.length > 0) this.select(agents[0].instanceId);
      else this.selected = null;
    }
  }

  select(id: string): void {
    if (this.selected === id) return;
    this.pending?.remove();
    this.pending = null;
    this.selected = id;
    for (const [k, t] of this.tabs) t.className = k === id ? "tab active" : "tab";
    this.cb.onSelect(id);
  }

  setStreaming(id: string, on: boolean): void {
    if (on) this.streaming.add(id);
    else this.streaming.delete(id);
    const dot = this.dots.get(id);
    if (dot) dot.style.animation = on ? "indicator-pulse 1.2s ease-in-out infinite" : "";
  }

  showPending(name: string): void {
    this.pending?.remove();
    const tab = el("div", { className: "tab pending" });
    tab.append(
      el("div", { className: "tab-dot dim", style: { background: "var(--text-2)" } }),
      el("span", { className: "tab-text" }, name),
    );
    this.strip.append(tab);
    this.pending = tab;
  }
}
