import { marked } from "marked";
import { el } from "../dom";
import { ICON } from "../panels/icons";
import type {
  AvailableAgent,
  AvailableCommand,
  ContextChip,
  FileSearchResult,
  SessionMeta,
  SessionMode,
} from "../types";
import { escapeHtml } from "../utils";

marked.setOptions({ breaks: true, gfm: true });
marked.use({
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

export interface ChatCb {
  onSend(text: string, instanceId: string | null, chips: ContextChip[]): void;
  onAddAgent(type: string, mode: SessionMode): void;
  onModeChange(id: string): void;
  onModelChange(id: string): void;
  onFileSearch(query: string): void;
  onPickerDismiss?(): void;
}

const OPT = "option";
const OPT_ON = "option active";

export class Chat {
  el: HTMLElement;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private chips: ContextChip[] = [];
  private chipBar: HTMLElement;
  private dropdowns: Record<string, HTMLElement>;
  private cb: ChatCb;
  private chatView: HTMLElement;
  private inputRow!: HTMLElement;
  private settingsBtn!: HTMLElement;

  private activeId: string | null = null;
  private msgMap = new Map<
    string,
    Array<{
      from: string;
      text: string;
      tools?: Array<{ id: string; name: string; title: string | null; status: string; input: string | null }>;
    }>
  >();
  private metaMap = new Map<string, SessionMeta>();
  private streamEl: HTMLElement | null = null;
  private thinkingEl: HTMLElement | null = null;
  private streamText = "";
  private streamRaf: number | null = null;
  private segmentOffset = 0;
  private streamingId: string | null = null;
  private toolEls = new Map<string, HTMLElement>();
  private streamTools: Array<{ id: string; name: string; title: string | null; status: string; input: string | null }> =
    [];
  private liveToolGroup: HTMLElement | null = null;

  private files: FileSearchResult[] = [];
  private fileIdx = -1;
  private atPos: number | null = null;
  private fileTimer: ReturnType<typeof setTimeout> | null = null;
  private cmds: AvailableCommand[] = [];
  private cmdIdx = -1;
  private agents: AvailableAgent[] = [];
  private open: string | null = null;
  private agentMode: SessionMode = "single_agent";
  private pendingAgentType: string | null = null;
  private pendingMsgs: Array<{ from: string; text: string }> = [];

  constructor(cb: ChatCb) {
    this.cb = cb;
    this.messages = el("div", { className: "chat-scroll" });

    this.input = document.createElement("textarea");
    this.input.className = "chat-input";
    this.input.rows = 1;
    this.input.placeholder = "Send a message...";
    this.input.setAttribute("aria-label", "Chat message");
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("input", () => {
      this.autoResize();
      this.onInput();
    });

    const sendBtn = el("button", {
      type: "button",
      className: "send-btn",
      innerHTML: ICON.send,
      "aria-label": "Send message",
    });
    sendBtn.addEventListener("click", () => this.doSend());

    this.settingsBtn = el("button", {
      type: "button",
      className: "settings-btn",
      innerHTML: ICON.settings,
      "aria-label": "Settings",
    });
    this.settingsBtn.addEventListener("click", () => this.toggle("settings"));

    this.dropdowns = {
      cmd: el("div", { className: "portal-dropdown" }),
      file: el("div", { className: "portal-dropdown" }),
      settings: el("div", { className: "portal-dropdown" }),
      agents: el("div", { className: "portal-dropdown" }),
    };
    for (const d of Object.values(this.dropdowns)) {
      d.style.display = "none";
      document.body.append(d);
    }

    this.dropdowns.cmd.addEventListener("mousedown", (e) => e.preventDefault());
    this.dropdowns.cmd.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
      if (t) this.pickCmd(Number(t.dataset.i));
    });
    this.dropdowns.file.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
      if (t) this.pickFile(Number(t.dataset.i));
    });
    this.dropdowns.settings.addEventListener("mousedown", (e) => e.preventDefault());
    this.dropdowns.agents.addEventListener("mousedown", (e) => e.preventDefault());

    this.chipBar = el("div", { className: "chip-bar" });
    this.chipBar.addEventListener("click", (e) => {
      const x = (e.target as HTMLElement).closest(".chip-x");
      if (!x) return;
      const c = x.closest("[data-chip]") as HTMLElement | null;
      if (c?.dataset.chip) {
        this.chips = this.chips.filter((ch) => ch.id !== c.dataset.chip);
        this.renderChips();
      }
    });

    this.inputRow = el("div", { className: "input-row glass" });
    this.inputRow.append(this.settingsBtn, this.input, sendBtn);

    this.chatView = el("div", { className: "chat-view" });
    this.chatView.append(this.messages, this.chipBar, this.inputRow);

    this.el = el("div", { className: "chat-root" });
    this.el.append(this.chatView);
  }

  repositionDropdowns(): void {
    if (this.open && this.dropdowns[this.open].style.display !== "none") {
      this.positionDropdown(this.open, this.inputRow, true);
    }
  }

  destroy(): void {
    if (this.streamRaf) {
      cancelAnimationFrame(this.streamRaf);
      this.streamRaf = null;
    }
    if (this.fileTimer) {
      clearTimeout(this.fileTimer);
      this.fileTimer = null;
    }
    for (const d of Object.values(this.dropdowns)) d.remove();
  }

  private positionDropdown(key: string, anchor: HTMLElement, above: boolean): void {
    const d = this.dropdowns[key];
    const r = anchor.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-md")) || 6;
    d.style.left = `${r.left}px`;
    d.style.width = `${r.width}px`;
    if (above) {
      d.style.bottom = `${window.innerHeight - r.top + gap}px`;
      d.style.top = "";
    } else {
      d.style.top = `${r.bottom + gap}px`;
      d.style.bottom = "";
    }
  }

  selectAgent(id: string): void {
    if (id === this.activeId && !this.pendingMsgs.length) return;
    this.activeId = id;
    this.pendingAgentType = null;
    this.close();
    const hadPending = this.pendingMsgs.length > 0;
    if (hadPending) {
      let list = this.msgMap.get(id);
      if (!list) {
        list = [];
        this.msgMap.set(id, list);
      }
      list.push(...this.pendingMsgs);
      this.pendingMsgs = [];
    }
    this.renderMessages();
    if (hadPending && this.streamingId !== id) {
      this.thinkingEl = el("div", { className: "thinking-dot" });
      this.messages.append(this.thinkingEl);
      this.messages.scrollTop = this.messages.scrollHeight;
    }
  }

  clearAgent(): void {
    this.activeId = null;
    this.pendingAgentType = null;
    this.renderMessages();
  }

  getPendingAgent(): { type: string; mode: SessionMode } | null {
    if (!this.pendingAgentType) return null;
    return { type: this.pendingAgentType, mode: this.agentMode };
  }

  addPendingMessage(text: string): void {
    const msg = { from: "user", text };
    this.pendingMsgs.push(msg);
    this.appendMsg(msg);
    this.thinkingEl = el("div", { className: "thinking-dot" });
    this.messages.append(this.thinkingEl);
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  setAgents(a: AvailableAgent[]): void {
    this.agents = a;
    if (this.open === "agents") this.renderAgentPicker();
  }
  setCommands(c: AvailableCommand[]): void {
    this.cmds = c;
  }

  showAgentPicker(): void {
    if (this.open === "agents") return;
    this.close();
    this.open = "agents";
    const p = this.dropdowns.agents;
    this.renderAgentPicker();
    p.style.display = "flex";
    this.positionDropdown("agents", this.inputRow, true);
  }

  private renderAgentPicker(): void {
    const p = this.dropdowns.agents;
    p.innerHTML = "";

    // Session type
    p.append(el("div", { className: "settings-label" }, "Session"));
    const modes: Array<{ label: string; value: SessionMode }> = [
      { label: "Normal", value: "single_agent" },
      { label: "Orchestrator", value: "orchestrator" },
    ];
    for (const m of modes) {
      const row = el("div", { className: m.value === this.agentMode ? OPT_ON : OPT }, m.label);
      row.addEventListener("click", () => {
        this.agentMode = m.value;
        this.renderAgentPicker();
      });
      p.append(row);
    }

    // Provider list
    p.append(el("div", { className: "settings-label" }, "Provider"));

    if (!this.agents.length) {
      p.append(el("div", { className: "option" }, "No providers available"));
      return;
    }

    for (const a of this.agents) {
      const selected = a.id === this.pendingAgentType;
      const btn = el("div", { className: selected ? OPT_ON : OPT }, a.name);
      btn.addEventListener("click", () => {
        if (this.pendingAgentType === a.id) {
          this.pendingAgentType = null;
          this.cb.onPickerDismiss?.();
        } else {
          this.pendingAgentType = a.id;
          this.cb.onAddAgent(a.id, this.agentMode);
        }
        this.renderAgentPicker();
      });
      p.append(btn);
    }
  }

  setMeta(meta: SessionMeta, id?: string): void {
    const key = id || this.activeId;
    if (key) this.metaMap.set(key, meta);
  }

  showFiles(results: FileSearchResult[]): void {
    this.files = results;
    this.fileIdx = results.length > 0 ? 0 : -1;
    this.open = "file";
    this.renderFiles();
  }

  streamStart(id: string): void {
    if (this.streamingId && this.streamingId !== id && this.streamText) {
      this.flushStream(this.streamingId);
    }
    this.streamingId = id;
    this.streamText = "";
    this.segmentOffset = 0;
    this.toolEls.clear();
    this.streamTools = [];
    this.liveToolGroup = null;
    if (id !== this.activeId) return;
    if (!this.thinkingEl) {
      this.thinkingEl = el("div", { className: "thinking-dot" });
      this.messages.append(this.thinkingEl);
    }
    this.streamEl = null;
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private flushStream(id: string): void {
    if (this.streamRaf) {
      cancelAnimationFrame(this.streamRaf);
      this.streamRaf = null;
    }
    if (this.streamText) {
      let list = this.msgMap.get(id);
      if (!list) {
        list = [];
        this.msgMap.set(id, list);
      }
      list.push({
        from: "agent",
        text: this.streamText,
        tools: this.streamTools.length ? [...this.streamTools] : undefined,
      });
    }
    this.streamEl = null;
    this.streamText = "";
    this.segmentOffset = 0;
    this.toolEls.clear();
    this.streamTools = [];
    this.liveToolGroup = null;
    this.streamingId = null;
  }

  streamChunk(text: string, id: string): void {
    this.streamText += text;
    if (id !== this.activeId) return;
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
    if (!this.streamEl) {
      this.streamEl = el("div", { className: "msg msg-agent" });
      this.messages.append(this.streamEl);
    }
    if (!this.streamRaf) {
      this.streamRaf = requestAnimationFrame(() => {
        this.streamRaf = null;
        if (this.streamEl) {
          this.streamEl.innerHTML = marked.parse(this.streamText.slice(this.segmentOffset)) as string;
          this.messages.scrollTop = this.messages.scrollHeight;
        }
      });
    }
  }

  streamEnd(id: string): void {
    if (this.streamRaf) {
      cancelAnimationFrame(this.streamRaf);
      this.streamRaf = null;
    }
    if (this.streamEl) {
      this.streamEl.innerHTML = marked.parse(this.streamText.slice(this.segmentOffset)) as string;
    }
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
    this.liveToolGroup = null;
    const key = id || this.activeId;
    if (this.streamText && key) {
      let list = this.msgMap.get(key);
      if (!list) {
        list = [];
        this.msgMap.set(key, list);
      }
      list.push({
        from: "agent",
        text: this.streamText,
        tools: this.streamTools.length ? [...this.streamTools] : undefined,
      });
    }
    this.streamEl = null;
    this.streamText = "";
    this.segmentOffset = 0;
    this.streamingId = null;
    this.toolEls.clear();
    this.streamTools = [];
  }

  toolCallStart(name: string, toolCallId: string, instanceId?: string | null): void {
    const target = instanceId || this.streamingId || this.activeId;
    this.streamEl = null;
    this.segmentOffset = this.streamText.length;
    this.streamTools.push({ id: toolCallId, name, title: null, status: "running", input: null });
    if (target !== this.activeId) return;
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
    if (!this.liveToolGroup) {
      this.liveToolGroup = el("div", { className: "msg msg-agent tool-bubble" }) as HTMLDivElement;
      this.messages.append(this.liveToolGroup);
    }
    const toolEl = el("div", { className: "tool-call" });
    toolEl.textContent = name;
    this.liveToolGroup.append(toolEl);
    this.toolEls.set(toolCallId, toolEl);
    this.liveToolGroup.scrollTop = this.liveToolGroup.scrollHeight;
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  toolCallComplete(
    toolCallId: string,
    title: string | null,
    status: string,
    input?: string | null,
    instanceId?: string | null,
  ): void {
    const target = instanceId || this.streamingId || this.activeId;
    const t = this.streamTools.find((s) => s.id === toolCallId);
    if (t) {
      if (title) t.title = title;
      t.status = status;
      if (input) t.input = input;
    }
    if (target !== this.activeId) return;
    const toolEl = this.toolEls.get(toolCallId);
    if (toolEl) {
      const label = title || toolEl.textContent || "";
      if (input) {
        toolEl.innerHTML = "";
        toolEl.append(el("span", {}, label), el("span", { className: "tool-input-preview" }, input));
      } else if (title) {
        toolEl.textContent = title;
      }
      toolEl.classList.add(status === "completed" ? "tool-done" : "tool-fail");
    }
    if (this.liveToolGroup) this.liveToolGroup.scrollTop = this.liveToolGroup.scrollHeight;
  }

  addMessage(msg: { from: string; text: string; instanceId?: string }): void {
    const id = msg.instanceId || this.activeId;
    if (!id) return;
    let list = this.msgMap.get(id);
    if (!list) {
      list = [];
      this.msgMap.set(id, list);
    }
    list.push({ from: msg.from, text: msg.text });
    if (id === this.activeId) {
      this.appendMsg(msg);
      this.messages.scrollTop = this.messages.scrollHeight;
    }
  }

  private toggle(which: string): void {
    if (this.open === which) {
      this.close();
      return;
    }
    this.close();
    this.open = which;

    if (which === "settings") {
      const meta = this.activeId ? this.metaMap.get(this.activeId) : undefined;
      if (!meta) {
        this.open = null;
        return;
      }
      const modes = meta.modes?.availableModes ?? [];
      const models = meta.models?.availableModels ?? [];
      if (!modes.length && !models.length) {
        this.open = null;
        return;
      }
      this.renderSettings(meta);
    }
  }

  close(): void {
    if (!this.open) return;
    const wasAgents = this.open === "agents";
    this.dropdowns[this.open].style.display = "none";
    this.dropdowns[this.open].innerHTML = "";
    if (this.fileTimer) {
      clearTimeout(this.fileTimer);
      this.fileTimer = null;
    }
    this.files = [];
    this.fileIdx = -1;
    this.atPos = null;
    this.cmdIdx = -1;
    this.open = null;
    if (wasAgents && !this.pendingAgentType) {
      this.cb.onPickerDismiss?.();
    }
  }

  private renderSettings(meta: SessionMeta): void {
    const p = this.dropdowns.settings;
    p.innerHTML = "";

    const section = (label: string, items: { name: string; active: boolean; pick: () => void }[]) => {
      if (!items.length) return;
      p.append(el("div", { className: "settings-label" }, label));
      for (const it of items) {
        const row = el("div", { className: it.active ? OPT_ON : OPT }, it.name);
        row.addEventListener("click", it.pick);
        p.append(row);
      }
    };

    const modes = meta.modes?.availableModes ?? [];
    const models = meta.models?.availableModels ?? [];
    section(
      "Mode",
      modes.map((m) => ({
        name: m.name || m.id,
        active: m.id === meta.modes?.currentModeId,
        pick: () => {
          if (meta.modes) meta.modes.currentModeId = m.id;
          this.cb.onModeChange(m.id);
          this.renderSettings(meta);
        },
      })),
    );
    section(
      "Model",
      models.map((m) => ({
        name: m.name || m.modelId,
        active: m.modelId === meta.models?.currentModelId,
        pick: () => {
          if (meta.models) meta.models.currentModelId = m.modelId;
          this.cb.onModelChange(m.modelId);
          this.renderSettings(meta);
        },
      })),
    );
    p.style.display = "flex";
    this.positionDropdown("settings", this.inputRow, true);
  }

  private doSend(): void {
    const text = this.input.value.trim();
    if (!text && !this.chips.length) return;
    if (!this.activeId && !this.pendingAgentType) return;
    this.close();
    const chips = [...this.chips];
    this.chips = [];
    this.renderChips();
    this.cb.onSend(text, this.activeId, chips);
    this.input.value = "";
    this.autoResize();
  }

  private autoResize(): void {
    this.input.style.height = "auto";
    const max = (parseFloat(getComputedStyle(this.input).lineHeight) || 18) * 4;
    this.input.style.height = `${Math.min(this.input.scrollHeight, max)}px`;
    this.input.style.overflowY = this.input.scrollHeight > max ? "auto" : "hidden";
    requestAnimationFrame(() => this.repositionDropdowns());
  }

  private onKey(e: KeyboardEvent): void {
    if (this.open && e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }

    if (this.open === "cmd") {
      const list = this.filteredCmds();
      if (list.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.cmdIdx = Math.min(this.cmdIdx + 1, list.length - 1);
          this.showCmds(list);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.cmdIdx = Math.max(this.cmdIdx - 1, 0);
          this.showCmds(list);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && this.cmdIdx >= 0)) {
          e.preventDefault();
          this.pickCmd(this.cmdIdx);
          return;
        }
      }
    }

    if (this.open === "file") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.fileIdx = Math.min(this.fileIdx + 1, this.files.length - 1);
        this.renderFiles();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.fileIdx = Math.max(this.fileIdx - 1, 0);
        this.renderFiles();
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && this.fileIdx >= 0) {
        e.preventDefault();
        this.pickFile(this.fileIdx);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (this.input.value.trim()) this.doSend();
      return;
    }
    if (e.key === "Enter" && e.shiftKey && this.input.selectionStart === 0) {
      e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && !this.input.value && this.chips.length) {
      this.chips.pop();
      this.renderChips();
    }
  }

  private onInput(): void {
    const word = this.input.value.split(/\s/)[0];
    if (word.startsWith("/") && !this.input.value.includes(" ")) {
      const list = this.filteredCmds();
      this.cmdIdx = list.length ? 0 : -1;
      this.showCmds(list);
    } else if (this.open === "cmd") {
      this.close();
    }
    this.checkFileSearch();
  }

  private filteredCmds(): AvailableCommand[] {
    const word = this.input.value.split(/\s/)[0];
    if (!word.startsWith("/")) return [];
    const q = word.slice(1).toLowerCase();
    return this.cmds.filter(
      (c) => c.name.toLowerCase().startsWith(q) || (c.description?.toLowerCase().includes(q) ?? false),
    );
  }

  private showCmds(list: AvailableCommand[]): void {
    if (!list.length) {
      this.close();
      return;
    }
    this.open = "cmd";
    const p = this.dropdowns.cmd;
    p.innerHTML = list
      .map((cmd, i) => {
        const desc = cmd.description ? `<span class="cmd-desc">${escapeHtml(cmd.description)}</span>` : "";
        const cls = i === this.cmdIdx ? OPT_ON : OPT;
        return `<div class="${cls}" data-i="${i}"><span class="cmd-name">/${escapeHtml(cmd.name)}</span>${desc}</div>`;
      })
      .join("");
    p.style.display = "flex";
    this.positionDropdown("cmd", this.inputRow, true);
    p.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  private pickCmd(i: number): void {
    const list = this.filteredCmds();
    if (i < 0 || i >= list.length) return;
    this.input.value = `/${list[i].name} `;
    this.input.focus();
    this.close();
  }

  private checkFileSearch(): void {
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const at = this.findAtTrigger(this.input.value, cursor);
    if (at) {
      this.atPos = at.pos;
      if (this.fileTimer) clearTimeout(this.fileTimer);
      this.fileTimer = setTimeout(() => this.cb.onFileSearch(at.query), 100);
    } else if (this.open === "file") {
      this.close();
    }
  }

  private findAtTrigger(val: string, cursor: number): { pos: number; query: string } | null {
    for (let i = cursor - 1; i >= 0; i--) {
      if (val[i] === "@" && (i === 0 || /\s/.test(val[i - 1]))) return { pos: i, query: val.slice(i + 1, cursor) };
      if (/\s/.test(val[i])) return null;
    }
    return null;
  }

  private renderFiles(): void {
    const p = this.dropdowns.file;
    if (!this.files.length) {
      p.innerHTML = '<div class="file-empty">No files found</div>';
      p.style.display = "flex";
      this.positionDropdown("file", this.inputRow, true);
      return;
    }
    p.innerHTML = this.files
      .map((r, i) => {
        const name = r.isDirectory ? `${r.fileName}/` : r.fileName;
        const cls = i === this.fileIdx ? `${OPT_ON} file-item` : `${OPT} file-item`;
        return `<div class="${cls}" data-i="${i}"><span class="file-name">${escapeHtml(name)}</span><span class="file-path">${escapeHtml(r.relativePath)}</span></div>`;
      })
      .join("");
    p.style.display = "flex";
    this.positionDropdown("file", this.inputRow, true);
    p.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  private pickFile(i: number): void {
    if (i < 0 || i >= this.files.length) return;
    const r = this.files[i];
    if (this.chips.some((c) => c.filePath === r.path)) {
      this.close();
      this.clearAtText();
      return;
    }
    this.clearAtText();
    this.chips.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      filePath: r.path,
      fileName: r.fileName,
      isDirectory: r.isDirectory || undefined,
    });
    this.renderChips();
    this.close();
    this.input.focus();
  }

  private clearAtText(): void {
    if (this.atPos === null) return;
    const cursor = this.input.selectionStart ?? this.input.value.length;
    this.input.value = `${this.input.value.slice(0, this.atPos)}${this.input.value.slice(cursor)}`;
    this.input.selectionStart = this.input.selectionEnd = this.atPos;
  }

  private renderChips(): void {
    if (!this.chips.length) {
      this.chipBar.innerHTML = "";
      return;
    }
    this.chipBar.innerHTML = this.chips
      .map((c) => {
        const label = c.isDirectory ? `${c.fileName}/` : c.fileName;
        return `<div class="chip" data-chip="${escapeHtml(c.id)}"><span class="truncate">${escapeHtml(label)}</span><button type="button" class="chip-x">&times;</button></div>`;
      })
      .join("");
  }

  setHistory(
    instanceKey: string,
    msgs: Array<{
      from: string;
      text: string;
      tools?: Array<{ id: string; name: string; title: string | null; status: string; input: string | null }>;
    }>,
  ): void {
    this.msgMap.set(instanceKey, msgs ? [...msgs] : []);
    if (this.activeId === instanceKey) {
      this.renderMessages();
    }
  }

  private renderMessages(): void {
    this.messages.innerHTML = "";
    this.streamEl = null;
    this.liveToolGroup = null;
    this.toolEls.clear();
    const list = this.activeId ? this.msgMap.get(this.activeId) : null;
    if (list) {
      for (const m of list) this.appendMsg(m);
    }
    if (this.streamingId === this.activeId) {
      this.renderActiveStream();
    }
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private renderActiveStream(): void {
    if (!this.streamTools.length && !this.streamText) return;
    if (this.streamTools.length) {
      this.liveToolGroup = el("div", { className: "msg msg-agent tool-bubble" });
      this.toolEls.clear();
      for (const t of this.streamTools) {
        const cls = `tool-call${t.status === "completed" ? " tool-done" : t.status === "failed" ? " tool-fail" : ""}`;
        const toolEl = el("div", { className: cls });
        const label = t.title || t.name;
        if (t.input) {
          toolEl.append(el("span", {}, label), el("span", { className: "tool-input-preview" }, t.input));
        } else {
          toolEl.textContent = label;
        }
        this.liveToolGroup.append(toolEl);
        this.toolEls.set(t.id, toolEl);
      }
      this.messages.append(this.liveToolGroup);
    }
    const textAfterTools = this.streamText.slice(this.segmentOffset);
    if (textAfterTools) {
      this.streamEl = el("div", { className: "msg msg-agent" });
      this.streamEl.innerHTML = marked.parse(textAfterTools) as string;
      this.messages.append(this.streamEl);
    }
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private appendMsg(msg: {
    from: string;
    text: string;
    tools?: Array<{ id: string; name: string; title: string | null; status: string; input: string | null }>;
  }): void {
    const isUser = msg.from === "user";
    const msgEl = el("div", { className: `msg ${isUser ? "msg-user" : "msg-agent"}` });
    if (isUser) {
      msgEl.textContent = msg.text;
    } else {
      msgEl.innerHTML = marked.parse(msg.text) as string;
    }
    this.messages.append(msgEl);
    if (msg.tools?.length) {
      const bubble = el("div", { className: "msg msg-agent tool-bubble" });
      for (const t of msg.tools) {
        const cls = `tool-call${t.status === "completed" ? " tool-done" : t.status === "failed" ? " tool-fail" : ""}`;
        const toolEl = el("div", { className: cls });
        const label = t.title || t.name;
        if (t.input) {
          toolEl.append(el("span", {}, label), el("span", { className: "tool-input-preview" }, t.input));
        } else {
          toolEl.textContent = label;
        }
        bubble.append(toolEl);
      }
      this.messages.append(bubble);
    }
  }
}
