// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";
import { ICON } from "../panels/icons";
import type { AvailableAgent, AvailableCommand, ContextChip, FileSearchResult, SessionMeta } from "../types";
import { escapeHtml } from "../utils";

export interface ChatCb {
  onSend(text: string, instanceId: string | null, chips: ContextChip[]): void;
  onAddAgent(type: string): void;
  onModeChange(id: string): void;
  onModelChange(id: string): void;
  onFileSearch(query: string): void;
}

const DROPDOWN =
  "absolute bottom-full mb-xs left-0 bg-raised backdrop-blur-xl border border-border-subtle rounded-xl p-md overflow-y-auto flex flex-col gap-sm";
const OPTION = "flex items-center gap-md px-md h-9 text-sm rounded-lg cursor-pointer";
const OPTION_ON = `${OPTION} bg-accent-muted text-accent`;
const OPTION_OFF = `${OPTION} text-muted hover:text-foreground hover:bg-raised`;

export class Chat {
  el: HTMLElement;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private chips: ContextChip[] = [];
  private chipBar: HTMLElement;
  private dropdowns: Record<string, HTMLElement>;
  private cb: ChatCb;
  private chatView: HTMLElement;
  private pickerView: HTMLElement;
  private emptyView: HTMLElement;

  private activeId: string | null = null;
  private msgMap = new Map<string, { from: string; text: string }[]>();
  private metaMap = new Map<string, SessionMeta>();
  private streamEl: HTMLElement | null = null;
  private streamText = "";

  private files: FileSearchResult[] = [];
  private fileIdx = -1;
  private atPos: number | null = null;
  private fileTimer: ReturnType<typeof setTimeout> | null = null;
  private cmds: AvailableCommand[] = [];
  private cmdIdx = -1;
  private agents: AvailableAgent[] = [];
  private open: string | null = null;

  constructor(cb: ChatCb) {
    this.cb = cb;
    this.messages = (
      <div className="flex-1 overflow-y-auto min-h-0 p-md space-y-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" />
    ) as HTMLElement;

    this.input = document.createElement("textarea");
    this.input.className =
      "flex-1 bg-transparent px-md text-foreground font-sans text-sm outline-none placeholder:text-faint resize-none leading-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
    this.input.rows = 1;
    this.input.placeholder = "Send a message...";
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("input", () => {
      this.autoResize();
      this.onInput();
    });

    const sendBtn = (
      <button
        type="button"
        className="shrink-0 w-7 h-7 bg-accent text-white border-none rounded-lg flex items-center justify-center cursor-pointer hover:brightness-110 [&>svg]:w-4 [&>svg]:h-4"
        innerHTML={ICON.send}
      />
    ) as HTMLButtonElement;
    sendBtn.addEventListener("click", () => this.doSend());

    const settingsBtn = (
      <button
        type="button"
        className="shrink-0 w-7 h-7 bg-raised backdrop-blur-xl border border-border-subtle rounded-lg flex items-center justify-center cursor-pointer text-muted hover:text-foreground [&>svg]:w-4 [&>svg]:h-4"
        innerHTML={ICON.settings}
      />
    ) as HTMLButtonElement;
    settingsBtn.addEventListener("click", () => this.toggle("settings"));

    this.dropdowns = {
      cmd: (<div className={`${DROPDOWN} max-h-[200px] hidden z-[11]`} />) as HTMLElement,
      file: (<div className={`${DROPDOWN} max-h-[400px] hidden z-10`} />) as HTMLElement,
      settings: (
        <div className="absolute top-10 left-md bg-raised backdrop-blur-xl border border-border-subtle rounded-xl p-md hidden z-[13] flex flex-col gap-sm" />
      ) as HTMLElement,
    };
    this.dropdowns.cmd.addEventListener("mousedown", (e) => e.preventDefault());
    this.dropdowns.cmd.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
      if (el) this.pickCmd(Number(el.dataset.i));
    });
    this.dropdowns.file.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
      if (el) this.pickFile(Number(el.dataset.i));
    });
    this.dropdowns.settings.addEventListener("mousedown", (e) => e.preventDefault());

    this.chipBar = (<div className="flex flex-wrap gap-sm px-md py-sm shrink-0 empty:hidden" />) as HTMLElement;

    const inputRow = (
      <div className="relative flex items-end shrink-0 mx-md mb-md bg-raised backdrop-blur-xl border border-border-subtle rounded-xl p-sm gap-xs" />
    ) as HTMLElement;
    inputRow.append(this.dropdowns.cmd, this.dropdowns.file, this.input, sendBtn);

    this.chatView = (<div className="relative flex flex-col h-full" />) as HTMLElement;
    this.chatView.append(
      this.messages,
      this.chipBar,
      inputRow,
      (<div className="absolute top-md left-md z-[13]">{settingsBtn}</div>) as HTMLElement,
      this.dropdowns.settings,
    );

    this.pickerView = (<div className="flex flex-col h-full" style={{ display: "none" }} />) as HTMLElement;

    this.emptyView = (
      <div className="flex flex-col items-center justify-center h-full text-center px-lg">
        <div className="text-muted text-sm">Select an agent to start working</div>
      </div>
    ) as HTMLElement;

    this.chatView.style.display = "none";

    this.el = (<div className="flex flex-col h-full" />) as HTMLElement;
    this.el.append(this.emptyView, this.chatView, this.pickerView);
  }

  selectAgent(id: string): void {
    this.activeId = id;
    this.close();
    this.emptyView.style.display = "none";
    this.chatView.style.display = "";
    this.pickerView.style.display = "none";
    this.renderMessages();
  }

  clearAgent(): void {
    this.activeId = null;
    this.close();
    this.emptyView.style.display = "";
    this.chatView.style.display = "none";
    this.pickerView.style.display = "none";
  }

  setAgents(a: AvailableAgent[]): void {
    this.agents = a;
  }
  setCommands(c: AvailableCommand[]): void {
    this.cmds = c;
  }

  showAgentPicker(): void {
    this.emptyView.style.display = "none";
    this.chatView.style.display = "none";
    this.pickerView.style.display = "";
    this.pickerView.innerHTML = "";
    const spacer = (<div className="flex-1" />) as HTMLElement;
    const list = (
      <div className="mx-md mb-md bg-raised backdrop-blur-xl border border-border-subtle rounded-xl p-md flex flex-col gap-sm" />
    ) as HTMLElement;
    for (const a of this.agents) {
      const btn = (<div className={OPTION_OFF}>{a.name}</div>) as HTMLElement;
      btn.addEventListener("click", () => this.cb.onAddAgent(a.id));
      list.append(btn);
    }
    this.pickerView.append(spacer, list);
  }

  removeAgent(id: string): void {
    this.msgMap.delete(id);
    this.metaMap.delete(id);
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
    if (id !== this.activeId) return;
    this.streamText = "";
    this.streamEl = (
      <div className="px-lg py-md text-sm whitespace-pre-wrap break-words text-foreground bg-raised mr-8 rounded-xl rounded-bl-sm" />
    ) as HTMLElement;
    this.messages.append(this.streamEl);
  }

  streamChunk(text: string, id: string): void {
    if (id !== this.activeId || !this.streamEl) return;
    this.streamText += text;
    this.streamEl.textContent = this.streamText;
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  streamEnd(id: string): void {
    if (id !== this.activeId) return;
    this.streamEl = null;
    this.streamText = "";
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
      const meta = this.activeId ? this.metaMap.get(this.activeId) : null;
      if (!meta) {
        this.open = null;
        return;
      }
      this.renderSettings(meta);
    }
  }

  private close(): void {
    if (!this.open) return;
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
  }

  private renderSettings(meta: SessionMeta): void {
    const p = this.dropdowns.settings;
    p.innerHTML = "";

    const section = (label: string, items: { name: string; active: boolean; pick: () => void }[]) => {
      if (!items.length) return;
      p.append(
        (
          <div className="px-md pt-md pb-xs text-xs text-faint font-medium uppercase tracking-wide">{label}</div>
        ) as HTMLElement,
      );
      for (const it of items) {
        const row = (<div className={it.active ? OPTION_ON : OPTION_OFF}>{it.name}</div>) as HTMLElement;
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
    p.style.display = "block";
  }

  private doSend(): void {
    const text = this.input.value.trim();
    if (!text && !this.chips.length) return;
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
        const desc = cmd.description ? `<span class="text-xs text-faint">${escapeHtml(cmd.description)}</span>` : "";
        const cls = i === this.cmdIdx ? OPTION_ON : OPTION_OFF;
        return `<div class="${cls}" data-i="${i}"><span class="font-medium shrink-0">/${escapeHtml(cmd.name)}</span>${desc}</div>`;
      })
      .join("");
    p.style.display = "block";
    p.querySelector(".bg-accent-muted")?.scrollIntoView({ block: "nearest" });
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
      p.innerHTML = '<div class="p-md text-center text-faint text-sm">No files found</div>';
      p.style.display = "block";
      return;
    }
    p.innerHTML = this.files
      .map((r, i) => {
        const name = r.isDirectory ? `${r.fileName}/` : r.fileName;
        const cls = i === this.fileIdx ? OPTION_ON : OPTION_OFF;
        return `<div class="${cls} flex-col !items-start !h-auto py-sm" data-i="${i}"><span class="text-sm">${escapeHtml(name)}</span><span class="text-xs text-faint font-mono truncate w-full">${escapeHtml(r.relativePath)}</span></div>`;
      })
      .join("");
    p.style.display = "block";
    p.querySelector(".bg-accent-muted")?.scrollIntoView({ block: "nearest" });
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
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 9),
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
    this.input.value = this.input.value.slice(0, this.atPos) + this.input.value.slice(cursor);
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
        return `<div class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-accent-muted text-accent rounded-lg max-w-[180px] font-mono" data-chip="${escapeHtml(c.id)}"><span class="truncate">${escapeHtml(label)}</span><button class="bg-transparent border-none cursor-pointer text-accent text-sm px-px opacity-60 leading-none shrink-0 chip-x hover:opacity-100">&times;</button></div>`;
      })
      .join("");
    this.chipBar.querySelectorAll(".chip-x").forEach((btn) => {
      btn.addEventListener("click", () => {
        const el = btn.closest("[data-chip]") as HTMLElement | null;
        if (el?.dataset.chip) {
          this.chips = this.chips.filter((c) => c.id !== el.dataset.chip);
          this.renderChips();
        }
      });
    });
  }

  private renderMessages(): void {
    this.messages.innerHTML = "";
    this.streamEl = null;
    const list = this.activeId ? this.msgMap.get(this.activeId) : null;
    if (!list) return;
    for (const m of list) this.appendMsg(m);
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private appendMsg(msg: { from: string; text: string }): void {
    const isUser = msg.from === "user";
    const el = (
      <div
        className={`px-lg py-md text-sm whitespace-pre-wrap break-words text-foreground rounded-xl${isUser ? " bg-accent-muted ml-8 rounded-br-sm" : " bg-raised mr-8 rounded-bl-sm"}`}
      />
    ) as HTMLElement;
    el.textContent = msg.text;
    this.messages.append(el);
  }
}
