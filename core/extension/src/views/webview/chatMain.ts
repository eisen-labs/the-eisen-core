import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeApi;

export type ToolKind =
  | "read" | "edit" | "delete" | "move" | "search"
  | "execute" | "think" | "fetch" | "switch_mode" | "other";

export interface Tool {
  name: string;
  input: string | null;
  output: string | null;
  status: "running" | "completed" | "failed";
  kind?: ToolKind;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export type ToolCallContentItem =
  | { type: "content"; content?: { type: "text"; text?: string } }
  | { type: "diff"; path?: string; oldText?: string; newText?: string }
  | { type: "terminal"; terminalId?: string };

export interface FileSearchResult {
  readonly path: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly languageId: string;
  readonly isDirectory: boolean;
}

export interface ContextChip {
  readonly id: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly languageId: string;
  readonly isDirectory?: boolean;
  readonly range?: { readonly startLine: number; readonly endLine: number };
}

interface PerInstanceUiState {
  contextChips: ContextChip[];
  availableCommands: AvailableCommand[];
  usageMeterText: string;
  isStreaming: boolean;
}

interface InstanceTabInfo {
  key: string;
  label: string;
  agentType: string;
  color: string;
  connected: boolean;
  isStreaming: boolean;
}

interface WebviewState {
  isConnected: boolean;
  inputValue: string;
  currentInstanceKey: string | null;
  instanceHtmlCache: Record<string, string>;
  instanceUiStates: Record<string, PerInstanceUiState>;
}

export interface ExtensionMessage {
  type: string;
  text?: string;
  html?: string;
  state?: string;
  agents?: Array<{ id: string; name: string; available: boolean }>;
  selected?: string;
  agentId?: string;
  instanceKey?: string;
  currentInstanceKey?: string;
  instances?: InstanceTabInfo[];
  isStreaming?: boolean;
  modeId?: string;
  modelId?: string;
  modes?: { availableModes: Array<{ id: string; name: string }>; currentModeId: string } | null;
  models?: { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string } | null;
  commands?: AvailableCommand[] | null;
  plan?: { entries: PlanEntry[] };
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: ToolKind;
  content?: ToolCallContentItem[];
  rawInput?: { command?: string; description?: string };
  rawOutput?: { output?: string };
  status?: string;
  terminalOutput?: string;
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string } | null;
  searchResults?: FileSearchResult[];
  chip?: ContextChip;
  contextChipNames?: string[];
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const ANSI_FG: Record<number, string> = {
  30: "ansi-black", 31: "ansi-red", 32: "ansi-green", 33: "ansi-yellow",
  34: "ansi-blue", 35: "ansi-magenta", 36: "ansi-cyan", 37: "ansi-white",
  90: "ansi-bright-black", 91: "ansi-bright-red", 92: "ansi-bright-green", 93: "ansi-bright-yellow",
  94: "ansi-bright-blue", 95: "ansi-bright-magenta", 96: "ansi-bright-cyan", 97: "ansi-bright-white",
};
const ANSI_BG: Record<number, string> = {
  40: "ansi-bg-black", 41: "ansi-bg-red", 42: "ansi-bg-green", 43: "ansi-bg-yellow",
  44: "ansi-bg-blue", 45: "ansi-bg-magenta", 46: "ansi-bg-cyan", 47: "ansi-bg-white",
  100: "ansi-bg-bright-black", 101: "ansi-bg-bright-red", 102: "ansi-bg-bright-green", 103: "ansi-bg-bright-yellow",
  104: "ansi-bg-bright-blue", 105: "ansi-bg-bright-magenta", 106: "ansi-bg-bright-cyan", 107: "ansi-bg-bright-white",
};
const ANSI_STYLE: Record<number, string> = { 1: "ansi-bold", 2: "ansi-dim", 3: "ansi-italic", 4: "ansi-underline" };
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

export function ansiToHtml(text: string): string {
  let result = "", lastIndex = 0, classes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = ANSI_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const t = escapeHtml(text.slice(lastIndex, match.index));
      result += classes.length > 0 ? `<span class="${classes.join(" ")}">${t}</span>` : t;
    }
    for (const code of match[1].split(";").map(c => parseInt(c, 10) || 0)) {
      if (code === 0) classes = [];
      else if (ANSI_STYLE[code]) { if (!classes.includes(ANSI_STYLE[code])) classes.push(ANSI_STYLE[code]); }
      else if (ANSI_FG[code]) { classes = classes.filter(c => !c.startsWith("ansi-") || c.startsWith("ansi-bg-") || c.startsWith("ansi-bold") || c.startsWith("ansi-dim") || c.startsWith("ansi-italic") || c.startsWith("ansi-underline")); classes.push(ANSI_FG[code]); }
      else if (ANSI_BG[code]) { classes = classes.filter(c => !c.startsWith("ansi-bg-")); classes.push(ANSI_BG[code]); }
    }
    lastIndex = match.index + match[0].length;
  }
  ANSI_RE.lastIndex = 0;
  if (lastIndex < text.length) {
    const t = escapeHtml(text.slice(lastIndex));
    result += classes.length > 0 ? `<span class="${classes.join(" ")}">${t}</span>` : t;
  }
  return result;
}

export function hasAnsiCodes(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

export function computeLineDiff(oldText: string | null | undefined, newText: string | null | undefined): Array<{ type: "add" | "remove"; line: string }> {
  if (!oldText && !newText) return [];
  if (!oldText) return newText!.split("\n").map(line => ({ type: "add", line }));
  if (!newText) return oldText!.split("\n").map(line => ({ type: "remove", line }));
  return [
    ...oldText.split("\n").map(line => ({ type: "remove" as const, line })),
    ...newText.split("\n").map(line => ({ type: "add" as const, line })),
  ];
}

export function renderDiff(path: string | undefined, oldText: string | null | undefined, newText: string | null | undefined): string {
  const lines = computeLineDiff(oldText, newText);
  if (lines.length === 0) return '<div class="diff-container"><div class="diff-empty">No changes</div></div>';
  const truncated = lines.length > 500;
  const show = truncated ? lines.slice(0, 500) : lines;
  let html = '<div class="diff-container">';
  if (path) html += '<div class="diff-header">' + escapeHtml(path) + "</div>";
  html += '<pre class="diff-content">';
  for (const d of show) {
    const prefix = d.type === "add" ? "+ " : "- ";
    html += '<div class="diff-line diff-' + d.type + '">' + escapeHtml(prefix + d.line) + "</div>";
  }
  html += "</pre>";
  if (truncated) html += '<div class="diff-truncated">... (truncated, showing first 500 of ' + lines.length + " lines)</div>";
  html += "</div>";
  return html;
}

export function getToolsHtml(tools: Record<string, Tool>, expandedToolId?: string | null): string {
  const ids = Object.keys(tools);
  if (ids.length === 0) return "";
  const items = ids.map(id => {
    const tool = tools[id];
    const cls = "status-" + (tool.status || "pending");
    let details = "";
    if (tool.input) details += '<div class="tool-input"><strong>$</strong> ' + escapeHtml(tool.input) + "</div>";
    if (tool.output) {
      const trunc = tool.output.length > 500 ? tool.output.slice(0, 500) + "..." : tool.output;
      const hasAnsi = hasAnsiCodes(trunc);
      details += '<pre class="tool-output' + (hasAnsi ? " terminal" : "") + '">' + (hasAnsi ? ansiToHtml(trunc) : escapeHtml(trunc)) + "</pre>";
    }
    const preview = tool.input ? '<span class="tool-input-preview">' + escapeHtml(tool.input) + "</span>" : "";
    if (details) {
      return '<li class="' + cls + '"><details class="tool-item"' + (id === expandedToolId ? " open" : "") + '><summary>' + escapeHtml(tool.name) + preview + "</summary>" + details + "</details></li>";
    }
    return '<li class="' + cls + '">' + escapeHtml(tool.name) + preview + "</li>";
  }).join("");
  return '<details class="tool-details" open><summary>' + ids.length + " tool" + (ids.length > 1 ? "s" : "") + '</summary><ul class="tool-list">' + items + "</ul></details>";
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function updateSelectLabel(select: HTMLSelectElement, prefix: string): void {
  Array.from(select.options).forEach(opt => { opt.textContent = opt.dataset.label || opt.textContent; });
  const sel = select.options[select.selectedIndex];
  if (sel?.dataset.label) sel.textContent = prefix + ": " + sel.dataset.label;
}

interface Elements {
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  statusDot: HTMLElement;
  statusText: HTMLElement;
  connectBtn: HTMLButtonElement;
  agentSelector: HTMLSelectElement;
  addAgentBtn: HTMLButtonElement;
  modeSelector: HTMLSelectElement;
  modelSelector: HTMLSelectElement;
  welcomeView: HTMLElement;
  commandAutocomplete: HTMLElement;
  filePicker: HTMLElement;
  chipStack: HTMLElement;
  planContainer: HTMLElement;
  usageMeterEl: HTMLElement;
  instanceTabsEl: HTMLElement;
  emptyState: HTMLElement;
  tabSidebar: HTMLElement;
  chatMain: HTMLElement;
}

function getElements(doc: Document): Elements {
  return {
    messagesEl: doc.getElementById("messages")!,
    inputEl: doc.getElementById("input") as HTMLTextAreaElement,
    sendBtn: doc.getElementById("send") as HTMLButtonElement,
    stopBtn: doc.getElementById("stop") as HTMLButtonElement,
    statusDot: doc.getElementById("status-dot")!,
    statusText: doc.getElementById("status-text")!,
    connectBtn: doc.getElementById("connect-btn") as HTMLButtonElement,
    agentSelector: doc.getElementById("agent-selector") as HTMLSelectElement,
    addAgentBtn: doc.getElementById("add-agent-btn") as HTMLButtonElement,
    modeSelector: doc.getElementById("mode-selector") as HTMLSelectElement,
    modelSelector: doc.getElementById("model-selector") as HTMLSelectElement,
    welcomeView: doc.getElementById("welcome-view")!,
    commandAutocomplete: doc.getElementById("command-autocomplete")!,
    filePicker: doc.getElementById("file-picker")!,
    chipStack: doc.getElementById("chip-stack")!,
    planContainer: doc.getElementById("agent-plan-container")!,
    usageMeterEl: doc.getElementById("usage-meter")!,
    instanceTabsEl: doc.getElementById("instance-tabs")!,
    emptyState: doc.getElementById("empty-state")!,
    tabSidebar: doc.getElementById("tab-sidebar")!,
    chatMain: doc.getElementById("chat-main")!,
  };
}

class WebviewController {
  private vscode: VsCodeApi;
  private el: Elements;
  private doc: Document;

  private currentMsg: HTMLElement | null = null;
  private currentText = "";
  private thinkingEl: HTMLElement | null = null;
  private planEl: HTMLElement | null = null;
  private thoughtEl: HTMLElement | null = null;
  private thoughtText = "";
  private tools: Record<string, Tool> = {};
  private isConnected = false;
  private msgTexts = new Map<HTMLElement, string>();
  private commands: AvailableCommand[] = [];
  private selectedCmdIdx = -1;
  private hasActiveTool = false;
  private expandedToolId: string | null = null;
  private isStreaming = false;

  // Instance-based caching (keyed by instance key, not agent type)
  private instanceHtmlCache = new Map<string, string>();
  private currentInstanceKey: string | null = null;
  private instanceUiStates = new Map<string, PerInstanceUiState>();

  // Available agents for spawn selector
  private availableAgents: Array<{ id: string; name: string; available: boolean }> = [];

  // Tab state
  private instances: InstanceTabInfo[] = [];

  private contextChips: ContextChip[] = [];
  private filePickerVisible = false;
  private selectedFileIdx = -1;
  private fileResults: FileSearchResult[] = [];
  private fileDebounce: ReturnType<typeof setTimeout> | null = null;
  private atPos: number | null = null;

  constructor(vscode: VsCodeApi, el: Elements, doc: Document, win: Window) {
    this.vscode = vscode;
    this.el = el;
    this.doc = doc;
    this.restore();
    this.bind(win);
    this.updateView();
    this.updateEmptyState();
    this.vscode.postMessage({ type: "ready" });
  }

  private restore(): void {
    const s = this.vscode.getState<WebviewState>();
    if (!s) return;
    this.isConnected = s.isConnected;
    this.el.inputEl.value = s.inputValue || "";
    this.currentInstanceKey = s.currentInstanceKey ?? null;
    if (s.instanceHtmlCache) for (const [id, html] of Object.entries(s.instanceHtmlCache)) this.instanceHtmlCache.set(id, html);
    if (s.instanceUiStates) for (const [id, st] of Object.entries(s.instanceUiStates)) this.instanceUiStates.set(id, st);
    if (this.currentInstanceKey) {
      const ui = this.instanceUiStates.get(this.currentInstanceKey);
      if (ui) {
        this.contextChips = ui.contextChips;
        this.commands = ui.availableCommands;
        this.renderChips();
        if (ui.usageMeterText) { this.el.usageMeterEl.textContent = ui.usageMeterText; this.el.usageMeterEl.style.display = "inline"; }
      }
    }
  }

  private save(): void {
    const html: Record<string, string> = {};
    this.instanceHtmlCache.forEach((v, k) => { html[k] = v; });
    const ui: Record<string, PerInstanceUiState> = {};
    this.instanceUiStates.forEach((v, k) => { ui[k] = v; });
    if (this.currentInstanceKey) {
      ui[this.currentInstanceKey] = { contextChips: this.contextChips, availableCommands: this.commands, usageMeterText: this.el.usageMeterEl.textContent || "", isStreaming: this.isStreaming };
    }
    this.vscode.setState<WebviewState>({ isConnected: this.isConnected, inputValue: this.el.inputEl.value, currentInstanceKey: this.currentInstanceKey, instanceHtmlCache: html, instanceUiStates: ui });
  }

  // --- Tab rendering ---

  private renderTabs(): void {
    const container = this.el.instanceTabsEl;
    container.innerHTML = "";
    for (const inst of this.instances) {
      const tab = this.doc.createElement("div");
      tab.className = "instance-tab" + (inst.key === this.currentInstanceKey ? " active" : "");
      tab.dataset.key = inst.key;
      tab.title = inst.agentType + (inst.connected ? " (connected)" : " (disconnected)");

      // Color indicator (left border is done via CSS using a CSS variable)
      tab.style.setProperty("--tab-color", inst.color);

      // Status dot
      const statusDot = this.doc.createElement("span");
      statusDot.className = "tab-status" + (inst.connected ? " connected" : "") + (inst.isStreaming ? " streaming" : "");
      tab.appendChild(statusDot);

      // Label
      const label = this.doc.createElement("span");
      label.className = "tab-label";
      label.textContent = inst.label;
      tab.appendChild(label);

      // Close button
      const closeBtn = this.doc.createElement("button");
      closeBtn.className = "tab-close";
      closeBtn.textContent = "\u00d7";
      closeBtn.title = "Close instance";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.vscode.postMessage({ type: "closeInstance", instanceKey: inst.key });
      });
      tab.appendChild(closeBtn);

      tab.addEventListener("click", () => {
        this.vscode.postMessage({ type: "switchInstance", instanceKey: inst.key });
      });

      container.appendChild(tab);
    }
    this.updateEmptyState();
  }

  private updateEmptyState(): void {
    const hasInstances = this.instances.length > 0;
    this.el.emptyState.style.display = hasInstances ? "none" : "flex";
    this.el.tabSidebar.style.display = hasInstances ? "flex" : "none";
    this.el.chatMain.style.display = hasInstances ? "flex" : "none";
  }

  // --- Binding ---

  private bind(win: Window): void {
    const { sendBtn, inputEl, messagesEl, modeSelector, modelSelector, commandAutocomplete } = this.el;

    sendBtn.addEventListener("click", () => this.send());
    this.el.stopBtn.addEventListener("click", () => {
      this.vscode.postMessage({ type: "cancel" });
      this.addMessage("Query interrupted", "system");
      this.hideThinking();
      this.isStreaming = false;
      this.updateButtons();
    });

    inputEl.addEventListener("keydown", (e) => {
      if (this.filePickerVisible && this.fileResults.length > 0) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.selectedFileIdx = Math.min(this.selectedFileIdx + 1, this.fileResults.length - 1); this.renderFileList(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.selectedFileIdx = Math.max(this.selectedFileIdx - 1, 0); this.renderFileList(); return; }
        if (e.key === "Tab" || (e.key === "Enter" && this.selectedFileIdx >= 0)) { e.preventDefault(); this.pickFile(this.selectedFileIdx); return; }
        if (e.key === "Escape") { e.preventDefault(); this.hideFiles(); return; }
      }
      if (e.key === "Backspace" && inputEl.value === "" && this.contextChips.length > 0) {
        e.preventDefault(); this.removeChip(this.contextChips[this.contextChips.length - 1].id); return;
      }
      const visible = commandAutocomplete.classList.contains("visible");
      const cmds = this.filteredCmds(inputEl.value.split(/\s/)[0]);
      if (visible && cmds.length > 0) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.selectedCmdIdx = Math.min(this.selectedCmdIdx + 1, cmds.length - 1); this.showCmds(cmds); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.selectedCmdIdx = Math.max(this.selectedCmdIdx - 1, 0); this.showCmds(cmds); return; }
        if (e.key === "Tab" || (e.key === "Enter" && this.selectedCmdIdx >= 0)) { e.preventDefault(); this.pickCmd(this.selectedCmdIdx); return; }
        if (e.key === "Escape") { e.preventDefault(); this.hideCmds(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
      else if (e.key === "Escape") { e.preventDefault(); if (this.isStreaming) this.vscode.postMessage({ type: "cancel" }); this.clearInput(); }
    });

    inputEl.addEventListener("input", () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
      this.updateAutocomplete();
      this.handleFileSearch();
      this.save();
    });

    commandAutocomplete.addEventListener("mousedown", (e) => { e.preventDefault(); });
    commandAutocomplete.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) this.pickCmd(parseInt(item.getAttribute("data-index") || "0", 10));
    });

    commandAutocomplete.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) { this.selectedCmdIdx = parseInt(item.getAttribute("data-index") || "0", 10); this.showCmds(this.filteredCmds(inputEl.value.split(/\s/)[0])); }
    });

    messagesEl.addEventListener("keydown", (e) => {
      const msgs = Array.from(messagesEl.querySelectorAll(".message"));
      const idx = msgs.indexOf(this.doc.activeElement as Element);
      if (e.key === "ArrowDown" && idx < msgs.length - 1) { e.preventDefault(); (msgs[idx + 1] as HTMLElement).focus(); }
      else if (e.key === "ArrowUp" && idx > 0) { e.preventDefault(); (msgs[idx - 1] as HTMLElement).focus(); }
    });

    this.el.connectBtn.addEventListener("click", () => { this.vscode.postMessage({ type: "connect" }); });
    modeSelector.addEventListener("change", () => { updateSelectLabel(modeSelector, "Mode"); this.vscode.postMessage({ type: "selectMode", modeId: modeSelector.value }); });
    modelSelector.addEventListener("change", () => { updateSelectLabel(modelSelector, "Model"); this.vscode.postMessage({ type: "selectModel", modelId: modelSelector.value }); });

    // Add Agent button — spawn a new instance of the currently selected provider
    this.el.addAgentBtn.addEventListener("click", () => {
      const selectedType = this.el.agentSelector.value;
      if (selectedType) {
        this.vscode.postMessage({ type: "spawnAgent", agentType: selectedType });
      }
    });

    this.el.filePicker.addEventListener("mousedown", (e) => { e.preventDefault(); });
    this.el.filePicker.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".file-picker-item");
      if (item) this.pickFile(parseInt(item.getAttribute("data-index") || "0", 10));
    });
    this.el.filePicker.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".file-picker-item");
      if (item) { this.selectedFileIdx = parseInt(item.getAttribute("data-index") || "0", 10); this.renderFileList(); }
    });
    this.el.chipStack.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".chip-remove");
      if (btn) { const id = btn.closest(".context-chip")?.getAttribute("data-chip-id"); if (id) this.removeChip(id); }
    });

    win.addEventListener("message", (e: MessageEvent<ExtensionMessage>) => this.handleMessage(e.data));
  }

  private addMessage(text: string, type: "user" | "assistant" | "error" | "system"): HTMLElement {
    const div = this.doc.createElement("div");
    div.className = "message " + type;
    div.setAttribute("tabindex", "0");
    if (type === "assistant" || type === "user") {
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.vscode.postMessage({ type: "copyMessage", text: this.msgTexts.get(div) || div.textContent || "" });
      });
    }
    div.textContent = text;
    this.msgTexts.set(div, text);
    this.el.messagesEl.appendChild(div);
    this.el.messagesEl.scrollTop = this.el.messagesEl.scrollHeight;
    return div;
  }

  private showThinking(): void {
    if (!this.thinkingEl) {
      this.thinkingEl = this.doc.createElement("div");
      this.thinkingEl.className = "message assistant";
      this.el.messagesEl.appendChild(this.thinkingEl);
    }
    this.thinkingEl.innerHTML = '<span class="thinking">Thinking</span>' + getToolsHtml(this.tools, this.expandedToolId);
    this.el.messagesEl.scrollTop = this.el.messagesEl.scrollHeight;
  }

  private hideThinking(): void {
    if (this.thinkingEl) { this.thinkingEl.remove(); this.thinkingEl = null; }
  }

  private updateView(): void {
    const hasMessages = this.el.messagesEl.children.length > 0;
    this.el.welcomeView.style.display = !this.isConnected && !hasMessages ? "flex" : "none";
    this.el.messagesEl.style.display = this.isConnected || hasMessages ? "flex" : "none";
  }

  private send(): void {
    const text = this.el.inputEl.value.trim();
    if (!text && this.contextChips.length === 0) return;
    const chips = this.contextChips.map(c => ({
      filePath: c.filePath, fileName: c.fileName, isDirectory: c.isDirectory,
      range: c.range ? { startLine: c.range.startLine, endLine: c.range.endLine } : undefined,
    }));
    this.vscode.postMessage({ type: "sendMessage", text, contextChips: chips.length > 0 ? chips : undefined });
    this.el.inputEl.value = "";
    this.el.inputEl.style.height = "auto";
    this.clearChips();
    this.hideFiles();
    this.save();
  }

  private updateButtons(): void {
    // Stop button: enabled only when streaming
    this.el.stopBtn.disabled = !this.isStreaming;
  }

  private clearInput(): void {
    this.el.inputEl.value = "";
    this.el.inputEl.style.height = "auto";
    this.el.inputEl.focus();
    this.hideCmds();
    this.save();
  }

  private filteredCmds(query: string): AvailableCommand[] {
    if (!query.startsWith("/")) return [];
    const s = query.slice(1).toLowerCase();
    return this.commands.filter(c => c.name.toLowerCase().startsWith(s) || c.description?.toLowerCase().includes(s));
  }

  private showCmds(cmds: AvailableCommand[]): void {
    const { commandAutocomplete, inputEl } = this.el;
    if (cmds.length === 0) { this.hideCmds(); return; }
    commandAutocomplete.innerHTML = cmds.map((cmd, i) => {
      const hint = cmd.input?.hint ? '<div class="command-hint">' + escapeHtml(cmd.input.hint) + "</div>" : "";
      return '<div class="command-item' + (i === this.selectedCmdIdx ? " selected" : "") + '" data-index="' + i + '">' +
        '<div class="command-name">' + escapeHtml(cmd.name) + "</div>" +
        '<div class="command-description">' + escapeHtml(cmd.description || "") + "</div>" + hint + "</div>";
    }).join("");
    commandAutocomplete.classList.add("visible");
    inputEl.setAttribute("aria-expanded", "true");
  }

  private hideCmds(): void {
    this.el.commandAutocomplete.classList.remove("visible");
    this.el.commandAutocomplete.innerHTML = "";
    this.selectedCmdIdx = -1;
    this.el.inputEl.setAttribute("aria-expanded", "false");
  }

  private pickCmd(index: number): void {
    const cmds = this.filteredCmds(this.el.inputEl.value.split(/\s/)[0]);
    if (index >= 0 && index < cmds.length) {
      this.el.inputEl.value = "/" + cmds[index].name + " ";
      this.el.inputEl.focus();
      this.hideCmds();
    }
  }

  private showPlan(entries: PlanEntry[]): void {
    if (entries.length === 0) { this.hidePlan(); return; }
    if (!this.planEl) {
      this.planEl = this.doc.createElement("div");
      this.planEl.className = "agent-plan-sticky";
      this.el.planContainer.appendChild(this.planEl);
    }
    const done = entries.filter(e => e.status === "completed").length;
    this.planEl.innerHTML =
      '<div class="plan-header"><span class="plan-title">Agent Plan</span><span class="plan-progress">' + done + "/" + entries.length + "</span></div>" +
      '<div class="plan-entries">' + entries.map(e =>
        '<div class="plan-entry plan-entry-' + e.status + ' plan-priority-' + e.priority + '"><span class="plan-content">' + escapeHtml(e.content) + "</span></div>"
      ).join("") + "</div>";
  }

  private hidePlan(): void {
    if (this.planEl) { this.planEl.remove(); this.planEl = null; }
  }

  private updateAutocomplete(): void {
    const first = this.el.inputEl.value.split(/\s/)[0];
    if (first.startsWith("/") && !this.el.inputEl.value.includes(" ")) {
      const f = this.filteredCmds(first);
      this.selectedCmdIdx = f.length > 0 ? 0 : -1;
      this.showCmds(f);
    } else this.hideCmds();
  }

  private detectAt(value: string, cursor: number): { pos: number; query: string } | null {
    for (let i = cursor - 1; i >= 0; i--) {
      if (value[i] === "@" && (i === 0 || /\s/.test(value[i - 1]))) return { pos: i, query: value.slice(i + 1, cursor) };
      if (/\s/.test(value[i])) return null;
    }
    return null;
  }

  private handleFileSearch(): void {
    const cursor = this.el.inputEl.selectionStart ?? this.el.inputEl.value.length;
    const trigger = this.detectAt(this.el.inputEl.value, cursor);
    if (trigger) {
      this.atPos = trigger.pos;
      if (this.fileDebounce) clearTimeout(this.fileDebounce);
      this.fileDebounce = setTimeout(() => { this.vscode.postMessage({ type: "fileSearch", query: trigger.query }); }, 100);
    } else this.hideFiles();
  }

  private showFiles(results: FileSearchResult[]): void {
    this.fileResults = results;
    this.selectedFileIdx = results.length > 0 ? 0 : -1;
    this.filePickerVisible = true;
    this.renderFileList();
  }

  private renderFileList(): void {
    const { filePicker, inputEl } = this.el;
    if (this.fileResults.length === 0) {
      filePicker.innerHTML = '<div class="file-picker-empty">No files found</div>';
      filePicker.classList.add("visible");
      inputEl.setAttribute("aria-expanded", "true");
      return;
    }
    filePicker.innerHTML = this.fileResults.map((r, i) => {
      const name = r.isDirectory ? r.fileName + "/" : r.fileName;
      return '<div class="file-picker-item' + (i === this.selectedFileIdx ? " selected" : "") + '" data-index="' + i + '">' +
        '<span class="file-picker-name">' + escapeHtml(name) + '</span><span class="file-picker-path">' + escapeHtml(r.relativePath) + "</span></div>";
    }).join("");
    filePicker.classList.add("visible");
    inputEl.setAttribute("aria-expanded", "true");
    filePicker.querySelector(".file-picker-item.selected")?.scrollIntoView({ block: "nearest" });
  }

  private hideFiles(): void {
    this.el.filePicker.classList.remove("visible");
    this.el.filePicker.innerHTML = "";
    this.filePickerVisible = false;
    this.selectedFileIdx = -1;
    this.fileResults = [];
    this.atPos = null;
    this.el.inputEl.setAttribute("aria-expanded", "false");
    if (this.fileDebounce) { clearTimeout(this.fileDebounce); this.fileDebounce = null; }
  }

  private pickFile(index: number): void {
    if (index < 0 || index >= this.fileResults.length) return;
    const r = this.fileResults[index];
    if (this.contextChips.some(c => c.filePath === r.path)) { this.hideFiles(); this.removeAtText(); return; }
    this.removeAtText();
    this.contextChips.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, filePath: r.path, fileName: r.fileName, languageId: r.languageId, isDirectory: r.isDirectory || undefined });
    this.renderChips();
    this.hideFiles();
    this.el.inputEl.focus();
  }

  private removeAtText(): void {
    if (this.atPos === null) return;
    const { inputEl } = this.el;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    inputEl.value = inputEl.value.slice(0, this.atPos) + inputEl.value.slice(cursor);
    inputEl.selectionStart = inputEl.selectionEnd = this.atPos;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  }

  private removeChip(id: string): void { this.contextChips = this.contextChips.filter(c => c.id !== id); this.renderChips(); }
  private clearChips(): void { this.contextChips = []; this.renderChips(); }

  private renderChips(): void {
    if (this.contextChips.length === 0) { this.el.chipStack.innerHTML = ""; return; }
    this.el.chipStack.innerHTML = this.contextChips.map(c => {
      const label = c.isDirectory ? c.fileName + "/" : c.range ? c.fileName + ":" + c.range.startLine + "-" + c.range.endLine : c.fileName;
      return '<div class="context-chip" data-chip-id="' + escapeHtml(c.id) + '"><span class="chip-name">' + escapeHtml(label) + '</span><button class="chip-remove">&times;</button></div>';
    }).join("");
  }

  private handleMessage(msg: ExtensionMessage): void {
    const { modeSelector, modelSelector } = this.el;

    switch (msg.type) {
      case "userMessage":
        if (msg.text || (msg.contextChipNames && msg.contextChipNames.length > 0)) {
          const el = this.addMessage(msg.text || "", "user");
          if (msg.contextChipNames && msg.contextChipNames.length > 0) {
            el.innerHTML = '<div class="message-context">' + msg.contextChipNames.map(n => '<span class="context-badge">' + escapeHtml(n) + "</span>").join("") + "</div>" + escapeHtml(msg.text || "");
          }
          this.showThinking();
          this.updateView();
        }
        break;
      case "streamStart":
        this.currentText = "";
        this.hasActiveTool = false;
        this.hideThought();
        this.isStreaming = true;
        this.updateButtons();
        break;
      case "streamChunk":
        if (this.hasActiveTool && msg.text) {
          this.hideThinking();
          if (Object.keys(this.tools).length > 0) {
            const m = this.addMessage("", "assistant");
            m.innerHTML = getToolsHtml(this.tools, this.expandedToolId);
          }
          this.currentMsg = null; this.currentText = ""; this.tools = {}; this.expandedToolId = null; this.hasActiveTool = false;
        }
        if (!this.currentMsg) { this.hideThinking(); this.currentMsg = this.addMessage("", "assistant"); }
        if (msg.text) {
          this.currentText += msg.text;
          this.currentMsg.innerHTML = marked.parse(this.currentText) as string;
          this.el.messagesEl.scrollTop = this.el.messagesEl.scrollHeight;
        }
        break;
      case "streamEnd":
        this.hideThinking();
        if (this.currentMsg) {
          this.currentMsg.innerHTML = (msg.html || "") + getToolsHtml(this.tools, this.expandedToolId);
          this.msgTexts.set(this.currentMsg, this.currentText);
        }
        this.currentMsg = null; this.currentText = ""; this.tools = {}; this.hasActiveTool = false; this.expandedToolId = null;
        this.hideThought(); this.isStreaming = false; this.updateButtons(); this.el.inputEl.focus();
        break;
      case "toolCallStart":
        if (msg.toolCallId && msg.name) {
          if (this.currentText.trim()) { this.finalizeMsg(); this.currentMsg = null; this.currentText = ""; }
          this.tools[msg.toolCallId] = { name: msg.name, input: null, output: null, status: "running", kind: msg.kind };
          this.hasActiveTool = true;
          this.showThinking();
        }
        break;
      case "toolCallComplete":
        if (msg.toolCallId && this.tools[msg.toolCallId]) {
          const tool = this.tools[msg.toolCallId];
          let output = "";
          if (msg.content && msg.content.length > 0) {
            const fc = msg.content[0];
            if (fc.type === "content" && fc.content?.text) output = fc.content.text;
            else if (fc.type === "terminal") output = msg.terminalOutput || "";
            else if (fc.type === "diff") output = renderDiff(fc.path, fc.oldText, fc.newText);
          }
          if (!output) output = msg.rawOutput?.output || "";
          if (msg.title) tool.name = msg.title;
          if (msg.kind) tool.kind = msg.kind;
          tool.input = msg.rawInput?.command || msg.rawInput?.description || "";
          tool.output = output;
          tool.status = (msg.status as Tool["status"]) || "completed";
          this.expandedToolId = msg.toolCallId;
          this.showThinking();
        }
        break;
      case "error":
        this.hideThinking();
        if (msg.text) this.addMessage(msg.text, "error");
        this.isStreaming = false; this.updateButtons(); this.el.inputEl.focus();
        break;
      case "agentError":
        if (msg.text) this.addMessage(msg.text, "error");
        break;
      case "connectionState":
        if (msg.state) {
          this.isConnected = msg.state === "connected";
          this.el.statusDot.className = "status-dot " + msg.state;
          this.el.statusText.textContent = msg.state === "connected" ? "Connected" : msg.state === "connecting" ? "Connecting..." : msg.state === "error" ? "Connection Failed" : "Disconnected";
          this.el.connectBtn.style.display = this.isConnected ? "none" : "inline-flex";
          this.updateView();
          this.save();
        }
        break;
      case "agents":
        if (msg.agents) {
          this.availableAgents = msg.agents;
          // Populate the provider selector dropdown
          const { agentSelector } = this.el;
          agentSelector.innerHTML = "";
          msg.agents.forEach(a => {
            const opt = this.doc.createElement("option");
            opt.value = a.id;
            opt.textContent = a.available ? a.name : a.name + " (not installed)";
            if (!a.available) opt.style.color = "var(--vscode-disabledForeground)";
            if (a.id === msg.selected) opt.selected = true;
            agentSelector.appendChild(opt);
          });
        }
        break;
      case "instanceList": {
        if (msg.instances) {
          this.instances = msg.instances;
          this.currentInstanceKey = msg.currentInstanceKey ?? this.currentInstanceKey;
          if (this.instances.length === 0) {
            this.currentInstanceKey = null;
          }
          this.renderTabs();
          this.save();
        }
        break;
      }
      case "instanceChanged": {
        // Save current instance's HTML and UI state
        if (this.currentInstanceKey) {
          this.instanceUiStates.set(this.currentInstanceKey, { contextChips: this.contextChips, availableCommands: this.commands, usageMeterText: this.el.usageMeterEl.textContent || "", isStreaming: this.isStreaming });
          this.instanceHtmlCache.set(this.currentInstanceKey, this.el.messagesEl.innerHTML);
        }
        // Switch to the new instance
        this.currentInstanceKey = msg.instanceKey ?? null;
        this.el.messagesEl.innerHTML = this.currentInstanceKey ? this.instanceHtmlCache.get(this.currentInstanceKey) ?? "" : "";
        this.currentMsg = null; this.currentText = ""; this.tools = {}; this.hasActiveTool = false; this.expandedToolId = null;
        this.msgTexts.clear();
        modeSelector.style.display = "none"; modelSelector.style.display = "none";
        this.hideCmds(); this.hideFiles(); this.hidePlan(); this.hideThought();
        const cached = this.currentInstanceKey ? this.instanceUiStates.get(this.currentInstanceKey) : undefined;
        if (cached) {
          this.contextChips = cached.contextChips; this.commands = cached.availableCommands; this.renderChips();
          if (cached.usageMeterText) { this.el.usageMeterEl.textContent = cached.usageMeterText; this.el.usageMeterEl.style.display = "inline"; }
          else { this.el.usageMeterEl.textContent = ""; this.el.usageMeterEl.style.display = "none"; }
        } else {
          this.contextChips = []; this.commands = []; this.renderChips();
          this.el.usageMeterEl.textContent = ""; this.el.usageMeterEl.style.display = "none";
        }
        // Use extension-provided isStreaming as authoritative source (it knows if sendMessage is still in flight)
        this.isStreaming = msg.isStreaming ?? cached?.isStreaming ?? false;
        this.updateButtons();
        this.renderTabs();
        this.updateView(); this.save();
        break;
      }
      // Legacy handler — treat as instanceChanged
      case "agentChanged": {
        if (this.currentInstanceKey) {
          this.instanceUiStates.set(this.currentInstanceKey, { contextChips: this.contextChips, availableCommands: this.commands, usageMeterText: this.el.usageMeterEl.textContent || "", isStreaming: this.isStreaming });
          this.instanceHtmlCache.set(this.currentInstanceKey, this.el.messagesEl.innerHTML);
        }
        this.currentInstanceKey = msg.agentId ?? null;
        this.el.messagesEl.innerHTML = this.currentInstanceKey ? this.instanceHtmlCache.get(this.currentInstanceKey) ?? "" : "";
        this.currentMsg = null; this.currentText = ""; this.tools = {}; this.hasActiveTool = false; this.expandedToolId = null;
        this.msgTexts.clear();
        modeSelector.style.display = "none"; modelSelector.style.display = "none";
        this.hideCmds(); this.hideFiles(); this.hidePlan(); this.hideThought();
        const legacyCached = this.currentInstanceKey ? this.instanceUiStates.get(this.currentInstanceKey) : undefined;
        if (legacyCached) {
          this.contextChips = legacyCached.contextChips; this.commands = legacyCached.availableCommands; this.renderChips();
          this.isStreaming = legacyCached.isStreaming;
          if (legacyCached.usageMeterText) { this.el.usageMeterEl.textContent = legacyCached.usageMeterText; this.el.usageMeterEl.style.display = "inline"; }
          else { this.el.usageMeterEl.textContent = ""; this.el.usageMeterEl.style.display = "none"; }
        } else {
          this.contextChips = []; this.commands = []; this.renderChips();
          this.isStreaming = false;
          this.el.usageMeterEl.textContent = ""; this.el.usageMeterEl.style.display = "none";
        }
        this.updateButtons();
        this.updateView(); this.save();
        break;
      }
      case "chatCleared":
        this.el.messagesEl.innerHTML = "";
        this.currentMsg = null; this.msgTexts.clear();
        modeSelector.style.display = "none"; modelSelector.style.display = "none";
        this.commands = []; this.hideCmds(); this.hideFiles(); this.clearChips(); this.hidePlan(); this.hideThought();
        this.el.usageMeterEl.textContent = ""; this.el.usageMeterEl.style.display = "none";
        this.updateView();
        break;
      case "triggerClearChat":
        this.vscode.postMessage({ type: "clearChat" });
        break;
      case "sessionMetadata": {
        const hasModes = msg.modes?.availableModes?.length;
        const hasModels = msg.models?.availableModels?.length;
        if (hasModes && msg.modes) {
          modeSelector.style.display = "inline-block";
          modeSelector.innerHTML = "";
          msg.modes.availableModes.forEach(m => {
            const opt = this.doc.createElement("option");
            opt.value = m.id; opt.textContent = m.name || m.id; opt.dataset.label = m.name || m.id;
            if (m.id === msg.modes?.currentModeId) opt.selected = true;
            modeSelector.appendChild(opt);
          });
          updateSelectLabel(modeSelector, "Mode");
        } else modeSelector.style.display = "none";
        if (hasModels && msg.models) {
          modelSelector.style.display = "inline-block";
          modelSelector.innerHTML = "";
          msg.models.availableModels.forEach(m => {
            const opt = this.doc.createElement("option");
            opt.value = m.modelId; opt.textContent = m.name || m.modelId; opt.dataset.label = m.name || m.modelId;
            if (m.modelId === msg.models?.currentModelId) opt.selected = true;
            modelSelector.appendChild(opt);
          });
          updateSelectLabel(modelSelector, "Model");
        } else modelSelector.style.display = "none";
        if (msg.commands && Array.isArray(msg.commands)) this.commands = msg.commands;
        break;
      }
      case "modeUpdate":
        if (msg.modeId) { modeSelector.value = msg.modeId; updateSelectLabel(modeSelector, "Mode"); }
        break;
      case "availableCommands":
        if (msg.commands && Array.isArray(msg.commands)) this.commands = msg.commands;
        break;
      case "plan":
        if (msg.plan?.entries) this.showPlan(msg.plan.entries);
        break;
      case "thoughtChunk":
        if (msg.text) this.appendThought(msg.text);
        break;
      case "usageUpdate": {
        if (msg.used != null && msg.size != null) {
          const pct = msg.size > 0 ? Math.round((msg.used / msg.size) * 100) : 0;
          const costStr = msg.cost && msg.cost.amount > 0 ? ` ($${msg.cost.amount.toFixed(2)})` : "";
          this.el.usageMeterEl.textContent = `${formatTokens(msg.used)}  ${pct}%${costStr}`;
          this.el.usageMeterEl.style.display = "inline";
        }
        break;
      }
      case "fileSearchResults":
        if (msg.searchResults) this.showFiles(msg.searchResults);
        break;
      case "addContextChipFromEditor":
        if (msg.chip && !this.contextChips.some(c => c.filePath === msg.chip!.filePath && c.range?.startLine === msg.chip!.range?.startLine && c.range?.endLine === msg.chip!.range?.endLine)) {
          this.contextChips.push(msg.chip);
          this.renderChips();
        }
        break;
      case "streamingState":
        // Extension tells us the authoritative streaming state for the active instance
        if (msg.isStreaming !== undefined) {
          this.isStreaming = msg.isStreaming;
          this.updateButtons();
        }
        break;
      case "focusChatInput":
        this.el.inputEl.focus();
        break;
    }
  }

  private appendThought(text: string): void {
    this.thoughtText += text;
    if (!this.thoughtEl) {
      this.thoughtEl = this.doc.createElement("details");
      this.thoughtEl.className = "agent-thought";
      this.thoughtEl.setAttribute("open", "");
      this.thoughtEl.innerHTML = '<summary class="thought-header"><span class="thought-title">Thinking...</span></summary><div class="thought-content"></div>';
      this.el.messagesEl.appendChild(this.thoughtEl);
    }
    const content = this.thoughtEl.querySelector(".thought-content");
    if (content) content.textContent = this.thoughtText;
    this.el.messagesEl.scrollTop = this.el.messagesEl.scrollHeight;
  }

  private hideThought(): void {
    if (this.thoughtEl) { this.thoughtEl.remove(); this.thoughtEl = null; this.thoughtText = ""; }
  }

  private finalizeMsg(): void {
    if (this.currentMsg && this.currentText.trim()) {
      this.currentMsg.innerHTML = (marked.parse(this.currentText) as string) + getToolsHtml(this.tools, this.expandedToolId);
      this.msgTexts.set(this.currentMsg, this.currentText);
    }
  }
}

if (typeof acquireVsCodeApi !== "undefined") {
  const vscode = acquireVsCodeApi();
  const el = getElements(document);
  new WebviewController(vscode, el, document, window);
}
