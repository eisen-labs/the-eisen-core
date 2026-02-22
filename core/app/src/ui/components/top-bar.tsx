// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";
import { ICON } from "../panels/icons";
import type { AgentInfo } from "../state";

export interface TopBarCb {
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
}

const TAB = "flex items-center gap-2 px-3 h-8 cursor-pointer shrink-0 rounded-lg text-sm";
const TAB_ON = `${TAB} bg-raised text-foreground`;
const TAB_OFF = `${TAB} text-muted hover:text-foreground hover:bg-raised`;

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
    this.strip = (
      <div className="flex items-center min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden gap-0.5" />
    ) as HTMLElement;
    const add = (
      <button
        type="button"
        className="w-8 h-8 border-none bg-transparent text-faint flex items-center justify-center cursor-pointer shrink-0 hover:text-foreground hover:bg-raised rounded-lg"
        innerHTML={ICON.plus}
      />
    ) as HTMLButtonElement;
    add.addEventListener("click", () => cb.onAdd());
    this.el = (<div className="flex items-center h-11 px-1.5 gap-0.5" />) as HTMLElement;
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
      const tab = (<div className={active ? TAB_ON : TAB_OFF} />) as HTMLElement;
      const dot = (
        <div
          className={`w-2.5 h-2.5 shrink-0 rounded-full${a.connected ? "" : " opacity-30"}`}
          style={{ background: a.color }}
        />
      ) as HTMLElement;
      const closeBtn = (
        <button
          type="button"
          className="w-4 h-4 shrink-0 bg-transparent border-none flex items-center justify-center cursor-pointer text-muted hover:text-foreground rounded opacity-0 group-hover:opacity-100 leading-none text-base"
        >
          ×
        </button>
      ) as HTMLButtonElement;
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onClose(a.instanceId);
      });
      tab.className = `${active ? TAB_ON : TAB_OFF} group`;
      tab.append(
        dot,
        (<span className="whitespace-nowrap overflow-hidden text-ellipsis">{a.displayName}</span>) as HTMLElement,
        closeBtn,
      );
      tab.addEventListener("click", () => this.select(a.instanceId));
      this.strip.append(tab);
      this.tabs.set(a.instanceId, tab);
      this.dots.set(a.instanceId, dot);
    }

    // Reconcile selection — but only notify the host if the selected tab
    // genuinely changed (avoids feedback loops where apply→onSelect→switchInstance
    // →instanceList→apply→onSelect repeats indefinitely).
    if (!this.selected && agents.length > 0) {
      this.selectSilent(agents[0].instanceId);
    } else if (this.selected && !agents.some((a) => a.instanceId === this.selected)) {
      if (agents.length > 0) this.selectSilent(agents[0].instanceId);
      else this.selected = null;
    }
  }

  /** Update visual selection without notifying the host (used during apply). */
  private selectSilent(id: string): void {
    this.selected = id;
    for (const [k, el] of this.tabs) el.className = k === id ? TAB_ON : TAB_OFF;
  }

  select(id: string): void {
    if (this.selected === id) return;
    this.pending?.remove();
    this.pending = null;
    this.selected = id;
    for (const [k, el] of this.tabs) el.className = `${k === id ? TAB_ON : TAB_OFF} group`;
    this.cb.onSelect(id);
  }

  getSelected(): string | null {
    return this.selected;
  }

  setStreaming(id: string, on: boolean): void {
    if (on) this.streaming.add(id);
    else this.streaming.delete(id);
    const dot = this.dots.get(id);
    if (dot) dot.style.animation = on ? "indicator-pulse 1.2s ease-in-out infinite" : "";
  }

  showPending(name: string): void {
    this.pending?.remove();
    const tab = (<div className={`${TAB} opacity-40 pointer-events-none`} />) as HTMLElement;
    tab.append(
      (<div className="w-2.5 h-2.5 shrink-0 rounded-full opacity-30 bg-muted" />) as HTMLElement,
      (<span className="whitespace-nowrap text-muted">{name}</span>) as HTMLElement,
    );
    this.strip.append(tab);
    this.pending = tab;
  }
}
