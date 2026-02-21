import { el } from "../dom";
import { ICON } from "../panels/icons";
import type { AgentInfo } from "../state";

const LOGO = `<svg viewBox="0 0 306 180" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M153 111.737L59.5283 180L95.5 69.5L112.206 81.6987L97.4355 127.55L136.088 99.3217L153 111.737Z" fill="currentColor"/><path d="M306 0.0322266L211.064 70.083L246.472 180L0 0L306 0.0322266ZM208.564 127.55L187.619 62.5273L245.219 20.0254L61.3057 20.0059L208.564 127.55Z" fill="currentColor"/></svg>`;

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
  private knownIds = new Set<string>();
  private pending: HTMLElement | null = null;

  constructor(cb: TopBarCb) {
    this.cb = cb;

    const logo = el("div", { className: "top-logo", innerHTML: LOGO });

    this.strip = el("div", { className: "tab-strip" });

    const add = el("button", {
      type: "button",
      className: "add-btn",
      innerHTML: ICON.plus,
      "aria-label": "New chat",
    });
    add.addEventListener("click", () => cb.onAdd());

    this.el = el("div", { className: "top-bar" });
    this.el.append(logo, this.strip, add);
  }

  apply(agents: AgentInfo[]): void {
    this.pending?.remove();
    this.pending = null;

    let newId: string | null = null;
    for (const a of agents) {
      if (!this.knownIds.has(a.instanceId)) newId = a.instanceId;
    }
    this.knownIds = new Set(agents.map((a) => a.instanceId));

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

    if (newId) {
      this.select(newId);
    } else if (!this.selected && agents.length > 0) {
      this.select(agents[0].instanceId);
    } else if (this.selected && !agents.some((a) => a.instanceId === this.selected)) {
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
    if (dot) dot.classList.toggle("streaming", on);
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
