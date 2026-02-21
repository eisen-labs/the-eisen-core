import { isLikelyFilePath, type NodeKind } from './state';

export const BACKGROUND = '#141414';

export const LINK_COLOR = 'rgba(255,255,255,0.3)';
export const LINK_WIDTH = 1;
export const CALL_LINK_COLOR = 'rgba(167, 139, 250, 0.8)';
export const CALL_LINK_WIDTH = 2;

export const NODE_STROKE = 'rgba(255,255,255,0.5)';
export const NODE_STROKE_WIDTH = 1.5;
export const IN_CONTEXT_STROKE = 'rgba(34, 197, 94, 0.7)';
export const IN_CONTEXT_OVERLAY = 'rgba(34, 197, 94, 0.5)';
export const WRITE_STROKE = '#f59e0b';
export const WRITE_OVERLAY = 'rgba(245, 158, 11, 0.45)';
export const SELECTED_STROKE = '#60a5fa';
export const SELECTED_STROKE_WIDTH = 2.5;
export const CALLER_STROKE = '#a78bfa';

export const FORCE_LINK_DISTANCE = 16;
export const FORCE_LINK_DISTANCE_FOLDER = 14;
export const FORCE_LINK_DISTANCE_SYMBOL = 10;
export const FORCE_LINK_STRENGTH = 0.2;
export const FORCE_CHARGE = -90;
export const FORCE_CHARGE_FOLDER = -220;
export const FORCE_CHARGE_ROOT = -220;
export const FORCE_CHARGE_DISTANCE_MAX = 460;
export const FORCE_COLLIDE_PADDING = 1.8;
export const FORCE_COLLIDE_FOLDER_EXTRA = 0;
export const FORCE_COLLIDE_STRENGTH = 0.82;
export const FORCE_COLLIDE_ITERATIONS = 2;
export const VELOCITY_DECAY = 0.1;
export const COOLDOWN_TICKS = 60;

export const LABEL_MIN_SCALE = 0.15;
export const LABEL_BASE_FONT = 10;
export const LABEL_MIN_FONT = 8;
export const LABEL_LINE_HEIGHT = 1.15;
export const LABEL_BG = 'rgba(30, 30, 30, 0.5)';
export const LABEL_FG = '#e5e7eb';
export const LABEL_OFFSET_Y = 2;

export const ZOOM_FIT_DELAY = 300;
export const ZOOM_FIT_DURATION = 400;
export const ZOOM_FIT_PADDING = 40;

// Agent color palette
export const AGENT_COLORS = [
  '#22d3ee',  // cyan
  '#fb7185',  // rose
  '#a78bfa',  // violet
  '#fbbf24',  // amber
  '#34d399',  // emerald
  '#38bdf8',  // sky
  '#f472b6',  // pink
];

// Agent ring rendering
export const AGENT_RING_WIDTH = 3;
export const AGENT_RING_GAP = 0.08;       // gap between arc segments in radians
export const AGENT_RING_OFFSET = 3.5;     // pixels outside the node circle

// Legend panel
export const LEGEND_BG = 'rgba(20, 20, 20, 0.85)';
export const LEGEND_BORDER = 'rgba(255, 255, 255, 0.1)';
export const LEGEND_TEXT = '#e5e7eb';
export const LEGEND_TEXT_DIM = 'rgba(255, 255, 255, 0.4)';
export const LEGEND_DOT_SIZE = 8;
export const LEGEND_FONT_SIZE = 11;
export const LEGEND_ROW_HEIGHT = 22;
export const LEGEND_PADDING = 10;
export const LEGEND_CORNER_RADIUS = 6;
export const LEGEND_WIDTH = 200;

const CODE_FILE_COLOR = '#d6dee8';
const NEUTRAL_FILE_COLOR = '#5f6773';
const YAML_FILE_COLOR = '#d06cff';
const TXT_FILE_COLOR = '#9ccc65';
const MARKDOWN_FILE_COLOR = '#32c67a';
const CODE_EXTS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.c', '.cpp', '.h', '.java', '.rb', '.php', '.lua', '.zig', '.kt', '.swift', '.m', '.r']);
const NEUTRAL_FILE_EXTS = new Set(['.toml', '.json', '.css', '.lock']);

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const FILE_BRIGHTNESS = 0.08;
const CLASS_METHOD_COLOR = '#3178c6';
const FUNCTION_COLOR = '#ecae7e';
const FOLDER_BASE = BACKGROUND;
const FOLDER_NODE = BACKGROUND;
const FOLDER_SELECTED_TINT = '#3b82f6';
const FOLDER_REFERENCED_TINT = '#a78bfa';
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hexToRgb(hex: string): Rgb {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { r: 156, g: 163, b: 175 };
  }
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
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

function getPathPart(id: string): string {
  return id.includes('::') ? id.slice(0, id.indexOf('::')) : id;
}

function folderKey(id: string): string {
  const path = getPathPart(id);
  const parts = path.split('/').filter(Boolean);
  const isFile = isLikelyFilePath(path);
  if (!isFile) return path || (parts[0] ?? '');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function hashKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return Math.abs(h);
}

function folderDepth(key: string): number {
  return key ? key.split('/').filter(Boolean).length : 0;
}

function folderColorRgb(key: string): Rgb {
  const base = hexToRgb(FOLDER_BASE);
  const depth = folderDepth(key);
  const depthLift = Math.min(0.05 + depth * 0.03, 0.2);
  const variation = (hashKey(key || 'root') % 6) * 0.012;
  return brighten(base, depthLift + variation);
}

function folderSelectedColorRgb(key: string): Rgb {
  return mixRgb(folderColorRgb(key), hexToRgb(FOLDER_SELECTED_TINT), 0.58);
}

function folderReferencedColorRgb(key: string): Rgb {
  return mixRgb(folderColorRgb(key), hexToRgb(FOLDER_REFERENCED_TINT), 0.58);
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

function getFileColor(path: string): Rgb {
  const dot = path.lastIndexOf('.');
  const ext = dot !== -1 ? path.slice(dot).toLowerCase() : '';
  if (CODE_EXTS.has(ext)) return hexToRgb(CODE_FILE_COLOR);
  if (ext === '.txt') return hexToRgb(TXT_FILE_COLOR);
  if (ext === '.yml' || ext === '.yaml') return hexToRgb(YAML_FILE_COLOR);
  if (ext === '.md') return hexToRgb(MARKDOWN_FILE_COLOR);
  return hexToRgb(NEUTRAL_FILE_EXTS.has(ext) ? NEUTRAL_FILE_COLOR : CODE_FILE_COLOR);
}

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
  if (kind === 'folder') return FOLDER_NODE;
  if (kind === 'class') return CLASS_METHOD_COLOR;
  if (kind === 'method' || kind === 'function') return FUNCTION_COLOR;

  return toCss(brighten(getFileColor(getPathPart(id)), FILE_BRIGHTNESS));
}

export function getNodeStroke(inContext?: boolean): string {
  return inContext ? IN_CONTEXT_STROKE : NODE_STROKE;
}
