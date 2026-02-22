import type { State } from "../state";

export interface ChatCallbacks {
  onAgentToggle(displayName: string): void;
  onAddAgent(agentType: string): void;
  onSend(text: string, agent: string | null): void;
}

export interface AvailableAgent {
  id: string;
  name: string;
}

const SVG_CHEVRON_DOWN = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const SVG_CHEVRON_UP = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
const SVG_SEND = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';

const STYLE = `
.cp{position:fixed;bottom:16px;left:16px;z-index:20;width:360px;display:flex;flex-direction:column;overflow:hidden;background:rgba(20,20,20,.75);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--ui-border-default);font:11px/1.4 inherit}
.cp *{outline:none;box-sizing:border-box}
.cp-g{height:4px;cursor:ns-resize;flex-shrink:0;border-bottom:1px solid var(--ui-border-default)}
.cp-h{display:flex;align-items:center;height:28px;flex-shrink:0;border-bottom:1px solid var(--ui-border-default)}
.cp-h-agents{display:flex;align-items:center;gap:8px;padding:0 8px;flex:1;overflow:hidden}
.cp-h>button{width:28px;height:28px;border:none;border-left:1px solid var(--ui-border-default);background:none;color:var(--ui-text-secondary);font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cp-body{display:flex;flex-direction:column;flex:1;min-height:0}
.cp-m{flex:1;overflow-y:auto;min-height:0}
.cp-pk{display:none;flex-wrap:wrap;gap:0;flex-shrink:0;border-top:1px solid var(--ui-border-default)}
.cp-pk.open{display:flex}
.cp-pk>button{height:28px;border:none;border-right:1px solid var(--ui-border-default);background:none;color:var(--ui-text-secondary);font:inherit;padding:0 8px;cursor:pointer}
.cp-pk>button:hover{color:var(--ui-text-primary)}
.cp-r{display:flex;flex-shrink:0;border-top:1px solid var(--ui-border-default)}
.cp-r>*{height:28px;width:28px;border:none;background:none;font:inherit;padding:0;display:flex;align-items:center;justify-content:center}
.cp-r>input{flex:1;width:auto;padding:0 8px;color:var(--ui-text-primary);cursor:text}
.cp-r>button:first-child{border-right:1px solid var(--ui-border-default);cursor:pointer}
.cp-r>button:last-child{border-left:1px solid var(--ui-border-default);cursor:pointer;color:var(--ui-text-secondary)}
`;

let injected = false;
function inject() {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = STYLE;
  document.head.append(s);
}

export class ChatPanel {
  private el: HTMLElement;
  private agentStrip: HTMLElement;
  private body: HTMLElement;
  private msgs: HTMLElement;
  private inp: HTMLInputElement;
  private spawnPicker: HTMLElement;
  private agentPicker: HTMLElement;
  private dot: HTMLElement;
  private chevron: HTMLButtonElement;
  private collapsed = false;
  private panelH = 320;
  private resizeY = 0;
  private resizeH = 0;
  private agent: string | null = null;
  private colors = new Map<string, string>();
  private cb: ChatCallbacks;

  constructor(cb: ChatCallbacks) {
    inject();
    this.cb = cb;

    this.el = document.createElement("div");
    this.el.className = "cp";
    this.el.style.height = this.panelH + "px";

    // resize grip
    const grip = document.createElement("div");
    grip.className = "cp-g";
    grip.addEventListener("mousedown", (e: MouseEvent) => {
      this.resizeY = e.clientY;
      this.resizeH = this.panelH;
      const move = (ev: MouseEvent) => {
        this.panelH = Math.max(100, Math.min(window.innerHeight * 0.6, this.resizeH + this.resizeY - ev.clientY));
        this.el.style.height = this.panelH + "px";
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    // header
    const hdr = document.createElement("div");
    hdr.className = "cp-h";
    this.agentStrip = document.createElement("div");
    this.agentStrip.className = "cp-h-agents";
    const addBtn = document.createElement("button");
    addBtn.innerHTML = SVG_PLUS;
    addBtn.addEventListener("click", () => this.toggleSpawnPicker());
    this.chevron = document.createElement("button");
    this.chevron.innerHTML = SVG_CHEVRON_DOWN;
    this.chevron.addEventListener("click", () => this.toggle());
    hdr.append(this.agentStrip, addBtn, this.chevron);

    // body (collapsible)
    this.body = document.createElement("div");
    this.body.className = "cp-body";

    this.msgs = document.createElement("div");
    this.msgs.className = "cp-m";

    // spawn picker (available agent types, triggered by "+")
    this.spawnPicker = document.createElement("div");
    this.spawnPicker.className = "cp-pk";

    // agent picker (connected agents, triggered by dot)
    this.agentPicker = document.createElement("div");
    this.agentPicker.className = "cp-pk";

    const row = document.createElement("div");
    row.className = "cp-r";

    const dotBtn = document.createElement("button");
    this.dot = document.createElement("div");
    this.dot.style.cssText = "width:8px;height:8px;background:var(--ui-text-muted)";
    dotBtn.append(this.dot);
    dotBtn.addEventListener("click", () => this.toggleAgentPicker());

    this.inp = document.createElement("input");
    this.inp.placeholder = "message...";
    this.inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && this.inp.value.trim()) this.send();
    });

    const send = document.createElement("button");
    send.innerHTML = SVG_SEND;
    send.addEventListener("click", () => this.send());

    row.append(dotBtn, this.inp, send);
    this.body.append(this.msgs, this.spawnPicker, this.agentPicker, row);
    this.el.append(grip, hdr, this.body);
    document.body.append(this.el);
  }

  private toggle(): void {
    this.collapsed = !this.collapsed;
    this.body.style.display = this.collapsed ? "none" : "";
    this.el.style.height = this.collapsed ? "auto" : this.panelH + "px";
    this.chevron.innerHTML = this.collapsed ? SVG_CHEVRON_UP : SVG_CHEVRON_DOWN;
  }

  private toggleSpawnPicker(): void {
    this.agentPicker.classList.remove("open");
    this.spawnPicker.classList.toggle("open");
  }

  private toggleAgentPicker(): void {
    this.spawnPicker.classList.remove("open");
    this.agentPicker.classList.toggle("open");
  }

  private pick(name: string, color: string): void {
    this.agent = name;
    this.dot.style.background = color;
    this.agentPicker.classList.remove("open");
  }

  private send(): void {
    const t = this.inp.value.trim();
    if (!t) return;
    this.cb.onSend(t, this.agent);
    this.inp.value = "";
  }

  setAvailableAgents(agents: AvailableAgent[]): void {
    this.spawnPicker.innerHTML = "";
    for (const a of agents) {
      const btn = document.createElement("button");
      btn.textContent = a.name;
      btn.addEventListener("click", () => {
        this.cb.onAddAgent(a.id);
        this.spawnPicker.classList.remove("open");
      });
      this.spawnPicker.append(btn);
    }
  }

  apply(state: State): void {
    this.agentStrip.innerHTML = "";
    this.agentPicker.innerHTML = "";
    this.colors.clear();

    for (const a of state.agents) {
      this.colors.set(a.displayName, a.color);

      const dimmed = state.agentFilterActive && !state.visibleAgents.has(a.displayName);
      const d = document.createElement("div");
      d.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;color:var(--ui-text-secondary)";
      if (dimmed) d.style.opacity = ".25";
      const dot = document.createElement("div");
      dot.style.cssText = "width:6px;height:6px;background:" + a.color;
      if (a.connected) dot.style.animation = "indicator-pulse 1.4s ease-in-out infinite";
      d.append(dot, a.displayName);
      d.addEventListener("click", () => this.cb.onAgentToggle(a.displayName));
      this.agentStrip.append(d);

      const btn = document.createElement("button");
      btn.textContent = a.displayName;
      btn.addEventListener("click", () => this.pick(a.displayName, a.color));
      this.agentPicker.append(btn);
    }

    if (!this.agent && state.agents.length > 0) {
      this.pick(state.agents[0].displayName, state.agents[0].color);
    }
  }

  addMessage(msg: { from: string; agent?: string; text: string }): void {
    const isUser = msg.from === "user";
    const el = document.createElement("div");
    el.style.cssText = "padding:4px 8px;border-bottom:1px solid var(--ui-border-subtle)" + (isUser ? ";background:var(--ui-bg-surface)" : "");
    const lbl = document.createElement("div");
    lbl.style.cssText = "font-size:10px;color:var(--ui-text-muted)";
    lbl.textContent = isUser ? "you" : (msg.agent || "agent");
    if (!isUser && msg.agent) {
      const c = this.colors.get(msg.agent);
      if (c) lbl.style.color = c;
    }
    el.append(lbl, msg.text);
    this.msgs.append(el);
    this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  destroy(): void { this.el.remove(); }
}
