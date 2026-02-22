import type { NodeKind } from "./state";
import { applyTheme } from "./ui/tokens";

export interface Rgb { r: number; g: number; b: number }

// --- Language colors ---

interface LangDef {
  readonly hex: string;
  readonly exts: readonly string[];
}

const LANGUAGES: Record<string, LangDef> = {
  typescript:  { hex: "#3178c6", exts: [".ts", ".tsx"] },
  javascript:  { hex: "#f1e05a", exts: [".js", ".jsx"] },
  python:      { hex: "#3572A5", exts: [".py"] },
  rust:        { hex: "#dea584", exts: [".rs"] },
  go:          { hex: "#00ADD8", exts: [".go"] },
  java:        { hex: "#b07219", exts: [".java"] },
  cpp:         { hex: "#f34b7d", exts: [".cpp", ".cc", ".cxx", ".hpp"] },
  c:           { hex: "#555555", exts: [".c", ".h"] },
  ruby:        { hex: "#701516", exts: [".rb"] },
  php:         { hex: "#4F5D95", exts: [".php"] },
  lua:         { hex: "#000080", exts: [".lua"] },
  zig:         { hex: "#ec915c", exts: [".zig"] },
  kotlin:      { hex: "#A97BFF", exts: [".kt", ".kts"] },
  swift:       { hex: "#F05138", exts: [".swift"] },
  objc:        { hex: "#438eff", exts: [".m"] },
  r:           { hex: "#198CE7", exts: [".r", ".R"] },
  shell:       { hex: "#89e051", exts: [".sh", ".bash", ".zsh"] },
  css:         { hex: "#663399", exts: [".css"] },
  html:        { hex: "#e34c26", exts: [".html", ".htm"] },
  yaml:        { hex: "#cb171e", exts: [".yaml", ".yml"] },
  toml:        { hex: "#9c4221", exts: [".toml"] },
  markdown:    { hex: "#083fa1", exts: [".md", ".mdx"] },
  json:        { hex: "#292929", exts: [".json"] },
};

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function luminance(c: Rgb): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function adjustForDark(c: Rgb): Rgb {
  const lum = luminance(c);
  if (lum >= 80) return c;
  const t = ((80 - lum) / 80) * 0.55;
  return {
    r: Math.round(c.r + (255 - c.r) * t),
    g: Math.round(c.g + (255 - c.g) * t),
    b: Math.round(c.b + (255 - c.b) * t),
  };
}

function adjustForLight(c: Rgb): Rgb {
  const lum = luminance(c);
  if (lum <= 200) return c;
  const t = ((lum - 200) / 55) * 0.45;
  return {
    r: Math.round(c.r * (1 - t)),
    g: Math.round(c.g * (1 - t)),
    b: Math.round(c.b * (1 - t)),
  };
}

// ext -> Rgb maps, built once at module load
const darkExtMap = new Map<string, Rgb>();
const lightExtMap = new Map<string, Rgb>();

for (const lang of Object.values(LANGUAGES)) {
  const base = hexToRgb(lang.hex);
  const dark = adjustForDark(base);
  const light = adjustForLight(base);
  for (const ext of lang.exts) {
    darkExtMap.set(ext, dark);
    lightExtMap.set(ext, light);
  }
}

let langIntensity = 1.0;

export function setLangIntensity(v: number): void {
  langIntensity = Math.max(0, Math.min(1, v));
}

// --- Palette ---

export interface Palette {
  background: string;
  folder: Rgb;
  class: Rgb;
  method: Rgb;
  function: Rgb;
  fileFallback: Rgb;
  inContextTint: Rgb;
  link: [number, number, number, number];
  hotzoneFill: string;
  hotzoneStroke: string;
  lassoFill: string;
  lassoStroke: string;
}

export const DARK: Palette = {
  background: "#141414",
  folder:       { r: 130, g: 130, b: 130 },
  class:        { r: 49,  g: 120, b: 198 },
  method:       { r: 86,  g: 182, b: 194 },
  function:     { r: 236, g: 174, b: 126 },
  fileFallback: { r: 190, g: 190, b: 190 },
  inContextTint:{ r: 34,  g: 197, b: 94  },
  link: [255, 255, 255, 1],
  hotzoneFill:   "rgba(220, 50, 50, 0.10)",
  hotzoneStroke: "rgba(220, 50, 50, 0.35)",
  lassoFill:     "rgba(96, 165, 250, 0.06)",
  lassoStroke:   "rgba(96, 165, 250, 0.45)",
};

export const LIGHT: Palette = {
  background: "#f0f0f0",
  folder:       { r: 100, g: 100, b: 100 },
  class:        { r: 37,  g: 99,  b: 160 },
  method:       { r: 14,  g: 140, b: 150 },
  function:     { r: 184, g: 122, b: 58  },
  fileFallback: { r: 90,  g: 90,  b: 90  },
  inContextTint:{ r: 20,  g: 150, b: 70  },
  link: [50, 50, 50, 1],
  hotzoneFill:   "rgba(200, 40, 40, 0.12)",
  hotzoneStroke: "rgba(200, 40, 40, 0.40)",
  lassoFill:     "rgba(50, 100, 200, 0.10)",
  lassoStroke:   "rgba(50, 100, 200, 0.50)",
};

export let palette: Palette = DARK;

export function setPalette(mode: "dark" | "light"): Palette {
  palette = mode === "dark" ? DARK : LIGHT;
  applyTheme(mode);
  return palette;
}

// --- Node sizing & coloring ---

const NODE_SIZE: Record<NodeKind, number> = {
  folder: 8, file: 5, class: 5, method: 3, function: 3,
};

export function nodeSize(kind: NodeKind, isRoot = false): number {
  return isRoot ? 12 : NODE_SIZE[kind];
}

function getFileColor(path: string): Rgb {
  const dot = path.lastIndexOf(".");
  const ext = dot !== -1 ? path.slice(dot).toLowerCase() : "";
  const mode = palette === DARK ? "dark" : "light";
  const lang = (mode === "dark" ? darkExtMap : lightExtMap).get(ext);
  if (!lang) return palette.fileFallback;
  const t = langIntensity;
  if (t >= 1) return lang;
  if (t <= 0) return palette.fileFallback;
  return {
    r: Math.round(palette.fileFallback.r * (1 - t) + lang.r * t),
    g: Math.round(palette.fileFallback.g * (1 - t) + lang.g * t),
    b: Math.round(palette.fileFallback.b * (1 - t) + lang.b * t),
  };
}

export function getNodeRgba(id: string, kind: NodeKind): [number, number, number, number] {
  if (kind === "folder") return [palette.folder.r, palette.folder.g, palette.folder.b, 1];
  if (kind === "class") return [palette.class.r, palette.class.g, palette.class.b, 1];
  if (kind === "method") return [palette.method.r, palette.method.g, palette.method.b, 1];
  if (kind === "function") return [palette.function.r, palette.function.g, palette.function.b, 1];

  const filePath = id.includes("::") ? id.slice(0, id.indexOf("::")) : id;
  const c = getFileColor(filePath);
  return [
    Math.min(255, Math.round(c.r + (255 - c.r) * 0.08)),
    Math.min(255, Math.round(c.g + (255 - c.g) * 0.08)),
    Math.min(255, Math.round(c.b + (255 - c.b) * 0.08)),
    1,
  ];
}
