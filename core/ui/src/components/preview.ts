import * as monaco from "monaco-editor";
import { el } from "../dom";

// biome-ignore lint/suspicious/noExplicitAny: Monaco requires global worker config
(self as any).MonacoEnvironment = {
  getWorker(_moduleId: string, _label: string) {
    const url = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/base/worker/workerMain.js";
    const blob = new Blob([`importScripts('${url}');`], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
  },
};

let themesRegistered = false;

function registerThemes() {
  if (themesRegistered) return;
  themesRegistered = true;

  monaco.editor.defineTheme("eisen-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#00000000",
      "editor.lineHighlightBackground": "#00000000",
      "editorLineNumber.foreground": "#ffffff4d",
      "editorLineNumber.activeForeground": "#ffffffe6",
      "editor.selectionBackground": "#0c8ce926",
      "editorWidget.background": "#141414",
      "editorWidget.border": "#ffffff0f",
      "editorCursor.foreground": "#ffffffe6",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff14",
    },
  });

  monaco.editor.defineTheme("eisen-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#00000000",
      "editor.lineHighlightBackground": "#00000000",
      "editorLineNumber.foreground": "#0000004d",
      "editorLineNumber.activeForeground": "#000000d9",
      "editor.selectionBackground": "#0c8ce91a",
      "editorWidget.background": "#f0f0f0",
      "editorWidget.border": "#0000000f",
      "editorCursor.foreground": "#000000d9",
      "scrollbarSlider.background": "#0000001a",
      "scrollbarSlider.hoverBackground": "#0000001a",
    },
  });
}

function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "eisen-dark" : "eisen-light";
}

export class Preview {
  el: HTMLElement;
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private currentPath: string | null = null;
  private decorationIds: string[] = [];
  onSave: ((path: string, content: string) => void) | null = null;

  constructor() {
    this.el = el("div", { className: "preview-editor" });
  }

  open(path: string, content: string, languageId: string): void {
    this.currentPath = path;

    registerThemes();
    const theme = currentTheme();

    if (!this.editor) {
      this.editor = monaco.editor.create(this.el, {
        value: content,
        language: languageId,
        theme,
        minimap: { enabled: false },
        fontSize: 11,
        lineNumbers: "off",
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 8,
        lineNumbersMinChars: 0,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontFamily: '"Geist Mono", "SF Mono", monospace',
        padding: { top: 8, bottom: 8 },
        overviewRulerLanes: 0,
        scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5, useShadows: false },
        renderLineHighlight: "none",
        contextmenu: false,
        wordWrap: "off",
        fixedOverflowWidgets: true,
        stickyScroll: { enabled: false },
      });

      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (this.currentPath && this.onSave) {
          this.onSave(this.currentPath, this.editor?.getValue() ?? "");
        }
      });
    } else {
      const oldModel = this.editor.getModel();
      const newModel = monaco.editor.createModel(content, languageId);
      this.editor.setModel(newModel);
      oldModel?.dispose();
      monaco.editor.setTheme(theme);
    }
  }

  revealLine(line: number): void {
    if (!this.editor) return;
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column: 1 });
  }

  highlightLines(startLine: number, endLine: number): void {
    if (!this.editor) return;
    this.decorationIds = this.editor.deltaDecorations(this.decorationIds, [
      {
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: { isWholeLine: true, className: "highlight-range" },
      },
    ]);
  }

  clearHighlight(): void {
    if (!this.editor) return;
    this.decorationIds = this.editor.deltaDecorations(this.decorationIds, []);
  }

  close(): void {
    this.currentPath = null;
  }

  setTheme(dark: boolean): void {
    registerThemes();
    monaco.editor.setTheme(dark ? "eisen-dark" : "eisen-light");
  }

  isOpen(): boolean {
    return this.currentPath !== null;
  }

  destroy(): void {
    if (this.editor) {
      this.editor.getModel()?.dispose();
      this.editor.dispose();
      this.editor = null;
    }
    this.currentPath = null;
  }
}
