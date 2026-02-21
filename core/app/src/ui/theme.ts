import { isLikelyFilePath, type NodeKind } from "./state";

// --- Types ---

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

// --- Language colors (ported from cosmos/src/theme.ts) ---

interface LangDef {
  readonly hex: string;
  readonly exts: readonly string[];
}

const LANGUAGES: Record<string, LangDef> = {
  typescript: { hex: "#3178c6", exts: [".ts", ".tsx"] },
  javascript: { hex: "#f1e05a", exts: [".js", ".jsx"] },
  python: { hex: "#3572A5", exts: [".py"] },
  rust: { hex: "#dea584", exts: [".rs"] },
  go: { hex: "#00ADD8", exts: [".go"] },
  java: { hex: "#b07219", exts: [".java"] },
  cpp: { hex: "#f34b7d", exts: [".cpp", ".cc", ".cxx", ".hpp"] },
  c: { hex: "#555555", exts: [".c", ".h"] },
  ruby: { hex: "#701516", exts: [".rb"] },
  php: { hex: "#4F5D95", exts: [".php"] },
  lua: { hex: "#000080", exts: [".lua"] },
  zig: { hex: "#ec915c", exts: [".zig"] },
  kotlin: { hex: "#A97BFF", exts: [".kt", ".kts"] },
  swift: { hex: "#F05138", exts: [".swift"] },
  objc: { hex: "#438eff", exts: [".m"] },
  r: { hex: "#198CE7", exts: [".r", ".R"] },
  shell: { hex: "#89e051", exts: [".sh", ".bash", ".zsh"] },
  css: { hex: "#663399", exts: [".css"] },
  html: { hex: "#e34c26", exts: [".html", ".htm"] },
  yaml: { hex: "#cb171e", exts: [".yaml", ".yml"] },
  toml: { hex: "#9c4221", exts: [".toml"] },
  markdown: { hex: "#083fa1", exts: [".md", ".mdx"] },
  json: { hex: "#292929", exts: [".json"] },
};

function hexToRgb(hex: string): Rgb {
  const n = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return { r: 156, g: 163, b: 175 };
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
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
  node: {
    folder: string;
    class: Rgb;
    method: Rgb;
    function: Rgb;
    fileFallback: Rgb;
    fileBrightness: number;
    stroke: string;
    strokeWidth: number;
    inContextStroke: string;
    inContextOverlay: string;
    writeStroke: string;
    writeOverlay: string;
    selectedStroke: string;
    selectedStrokeWidth: number;
    callerStroke: string;
  };
  link: {
    color: string;
    width: number;
    callColor: string;
    callWidth: number;
  };
  force: {
    linkDistance: number;
    linkDistanceFolder: number;
    linkDistanceSymbol: number;
    linkStrength: number;
    charge: number;
    chargeFolder: number;
    chargeRoot: number;
    chargeDistanceMax: number;
    collidePadding: number;
    collideFolderExtra: number;
    collideStrength: number;
    collideIterations: number;
    velocityDecay: number;
    cooldownTicks: number;
  };
  label: {
    minScale: number;
    baseFont: number;
    minFont: number;
    lineHeight: number;
    bg: string;
    fg: string;
    offsetY: number;
  };
  zoom: {
    fitDelay: number;
    fitDuration: number;
    fitPadding: number;
  };
  region: {
    base: string;
    selectedTint: string;
    referencedTint: string;
  };
  agent: {
    colors: string[];
    ringWidth: number;
    ringGap: number;
    ringOffset: number;
  };
}

const SHARED_FORCE: Palette["force"] = {
  linkDistance: 16,
  linkDistanceFolder: 14,
  linkDistanceSymbol: 10,
  linkStrength: 0.2,
  charge: -90,
  chargeFolder: -220,
  chargeRoot: -220,
  chargeDistanceMax: 460,
  collidePadding: 1.8,
  collideFolderExtra: 0,
  collideStrength: 0.82,
  collideIterations: 2,
  velocityDecay: 0.1,
  cooldownTicks: 60,
};

const SHARED_ZOOM: Palette["zoom"] = {
  fitDelay: 300,
  fitDuration: 400,
  fitPadding: 40,
};

const SHARED_AGENT: Palette["agent"] = {
  colors: ["#22d3ee", "#fb7185", "#a78bfa", "#fbbf24", "#34d399", "#38bdf8", "#f472b6"],
  ringWidth: 3,
  ringGap: 0.08,
  ringOffset: 3.5,
};

export const DARK: Palette = {
  background: "#141414",
  node: {
    folder: "#141414",
    class: { r: 49, g: 120, b: 198 },
    method: { r: 86, g: 182, b: 194 },
    function: { r: 236, g: 174, b: 126 },
    fileFallback: { r: 214, g: 222, b: 232 },
    fileBrightness: 0.08,
    stroke: "rgba(255,255,255,0.5)",
    strokeWidth: 1.5,
    inContextStroke: "rgba(34, 197, 94, 0.7)",
    inContextOverlay: "rgba(34, 197, 94, 0.5)",
    writeStroke: "#f59e0b",
    writeOverlay: "rgba(245, 158, 11, 0.45)",
    selectedStroke: "#60a5fa",
    selectedStrokeWidth: 2.5,
    callerStroke: "#a78bfa",
  },
  link: {
    color: "rgba(255,255,255,0.3)",
    width: 1,
    callColor: "rgba(167, 139, 250, 0.8)",
    callWidth: 2,
  },
  force: { ...SHARED_FORCE },
  label: {
    minScale: 0.15,
    baseFont: 10,
    minFont: 8,
    lineHeight: 1.15,
    bg: "rgba(30, 30, 30, 0.5)",
    fg: "#e5e7eb",
    offsetY: 2,
  },
  zoom: { ...SHARED_ZOOM },
  region: {
    base: "#141414",
    selectedTint: "#3b82f6",
    referencedTint: "#a78bfa",
  },
  agent: { ...SHARED_AGENT },
};

export const LIGHT: Palette = {
  background: "#f0f0f0",
  node: {
    folder: "#f0f0f0",
    class: { r: 37, g: 99, b: 160 },
    method: { r: 14, g: 140, b: 150 },
    function: { r: 184, g: 122, b: 58 },
    fileFallback: { r: 90, g: 90, b: 90 },
    fileBrightness: 0.08,
    stroke: "rgba(0,0,0,0.5)",
    strokeWidth: 1.5,
    inContextStroke: "rgba(20, 150, 70, 0.7)",
    inContextOverlay: "rgba(20, 150, 70, 0.5)",
    writeStroke: "#d97706",
    writeOverlay: "rgba(217, 119, 6, 0.45)",
    selectedStroke: "#3b82f6",
    selectedStrokeWidth: 2.5,
    callerStroke: "#7c3aed",
  },
  link: {
    color: "rgba(0,0,0,0.3)",
    width: 1,
    callColor: "rgba(124, 58, 237, 0.8)",
    callWidth: 2,
  },
  force: { ...SHARED_FORCE },
  label: {
    minScale: 0.15,
    baseFont: 10,
    minFont: 8,
    lineHeight: 1.15,
    bg: "rgba(240, 240, 240, 0.5)",
    fg: "#1f2937",
    offsetY: 2,
  },
  zoom: { ...SHARED_ZOOM },
  region: {
    base: "#f0f0f0",
    selectedTint: "#3b82f6",
    referencedTint: "#7c3aed",
  },
  agent: { ...SHARED_AGENT },
};

export let palette: Palette = DARK;

export function setPalette(mode: "dark" | "light"): Palette {
  palette = mode === "dark" ? DARK : LIGHT;
  return palette;
}

// --- Color utilities ---

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function toCss(rgb: Rgb, alpha = 1): string {
  const a = clamp01(alpha);
  const r = clampByte(rgb.r);
  const g = clampByte(rgb.g);
  const b = clampByte(rgb.b);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = clamp01(amount);
  return {
    r: clampByte(a.r + (b.r - a.r) * t),
    g: clampByte(a.g + (b.g - a.g) * t),
    b: clampByte(a.b + (b.b - a.b) * t),
  };
}

function brighten(rgb: Rgb, amount: number): Rgb {
  return mixRgb(rgb, WHITE, amount);
}

// --- Path / folder helpers ---

function getPathPart(id: string): string {
  return id.includes("::") ? id.slice(0, id.indexOf("::")) : id;
}

function folderKey(id: string): string {
  const path = getPathPart(id);
  const parts = path.split("/").filter(Boolean);
  const isFile = isLikelyFilePath(path);
  if (!isFile) return path || (parts[0] ?? "");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function hashKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function folderDepth(key: string): number {
  return key ? key.split("/").filter(Boolean).length : 0;
}

// --- Region / folder colors ---

function folderColorRgb(key: string): Rgb {
  const base = hexToRgb(palette.region.base);
  const depth = folderDepth(key);
  const depthLift = Math.min(0.05 + depth * 0.03, 0.2);
  const variation = (hashKey(key || "root") % 6) * 0.012;
  return brighten(base, depthLift + variation);
}

function folderSelectedColorRgb(key: string): Rgb {
  return mixRgb(folderColorRgb(key), hexToRgb(palette.region.selectedTint), 0.58);
}

function folderReferencedColorRgb(key: string): Rgb {
  return mixRgb(folderColorRgb(key), hexToRgb(palette.region.referencedTint), 0.58);
}

export function getFolderBg(key: string, alpha = 0.14): string {
  return toCss(folderColorRgb(key), alpha);
}

export function getFolderStroke(key: string, alpha = 0.28): string {
  return toCss(brighten(folderColorRgb(key), 0.16), alpha);
}

export function getFolderBgSelected(key: string, alpha = 0.14): string {
  return toCss(folderSelectedColorRgb(key), alpha);
}

export function getFolderStrokeSelected(key: string, alpha = 0.24): string {
  return toCss(brighten(folderSelectedColorRgb(key), 0.12), alpha);
}

export function getFolderBgReferenced(key: string, alpha = 0.14): string {
  return toCss(folderReferencedColorRgb(key), alpha);
}

export function getFolderStrokeReferenced(key: string, alpha = 0.24): string {
  return toCss(brighten(folderReferencedColorRgb(key), 0.12), alpha);
}

// --- File color (per-language) ---

function getFileColor(path: string): Rgb {
  const dot = path.lastIndexOf(".");
  const ext = dot !== -1 ? path.slice(dot).toLowerCase() : "";
  const mode = palette === DARK ? "dark" : "light";
  const lang = (mode === "dark" ? darkExtMap : lightExtMap).get(ext);
  if (!lang) return palette.node.fileFallback;
  const t = langIntensity;
  if (t >= 1) return lang;
  if (t <= 0) return palette.node.fileFallback;
  return {
    r: Math.round(palette.node.fileFallback.r * (1 - t) + lang.r * t),
    g: Math.round(palette.node.fileFallback.g * (1 - t) + lang.g * t),
    b: Math.round(palette.node.fileFallback.b * (1 - t) + lang.b * t),
  };
}

// --- Node sizing & public API ---

const NODE_VAL: Record<NodeKind, number> = {
  folder: 10,
  file: 6,
  class: 6,
  method: 4,
  function: 4,
};

export function nodeVal(kind: NodeKind): number {
  return NODE_VAL[kind];
}

export function nodeRadius(kind: NodeKind): number {
  return Math.sqrt(NODE_VAL[kind]) * 2;
}

export function getRegionKey(id: string): string {
  return folderKey(id);
}

export function getNodeColor(id: string, kind: NodeKind): string {
  if (kind === "folder") return palette.node.folder;
  if (kind === "class") return toCss(palette.node.class);
  if (kind === "method") return toCss(palette.node.method);
  if (kind === "function") return toCss(palette.node.function);
  return toCss(brighten(getFileColor(getPathPart(id)), palette.node.fileBrightness));
}

export function getNodeStroke(inContext?: boolean): string {
  return inContext ? palette.node.inContextStroke : palette.node.stroke;
}
