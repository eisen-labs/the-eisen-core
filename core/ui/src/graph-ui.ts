import type { Inspect, NodeMeta } from "./components/inspect";
import type { Preview } from "./components/preview";
import type { Node, NodeKind, State } from "./state";
import { getBadgeColor } from "./theme";

export function deriveKind(id: string, node?: Node): string {
  if (node?.kind) return node.kind;
  if (!id.includes("::")) return id.includes(".") ? "file" : "folder";
  return id.split("::").length === 2 ? "class" : "method";
}

export function buildMeta(id: string, node?: Node): NodeMeta {
  const kind = deriveKind(id, node);
  const meta: NodeMeta = { kind, badgeColor: getBadgeColor(id, kind as NodeKind) };
  if (node?.lines) {
    const total = node.lines.end - node.lines.start + 1;
    const showTotal = kind === "class" || kind === "method" || kind === "function";
    meta.lines = showTotal
      ? `${node.lines.start}-${node.lines.end} (${total})`
      : `${node.lines.start}-${node.lines.end}`;
  }
  if (node?.tokens) meta.tokens = String(node.tokens);
  if (node?.lastAction) meta.action = node.lastAction;
  if (node?.agentHeat) meta.agents = Object.keys(node.agentHeat).join(", ");
  return meta;
}

export interface SelectionContext {
  state: State;
  inspect: Inspect;
  preview: Preview;
  right: HTMLElement;
  tooltip: HTMLElement;
  tooltipInspect: Inspect;
  sendReadFile: (filePath: string) => void;
}

export function showTooltip(ctx: SelectionContext, id: string, sx: number, sy: number): void {
  const node = ctx.state.nodes.get(id);
  ctx.tooltipInspect.show(id, buildMeta(id, node));
  ctx.tooltip.style.left = `${sx}px`;
  ctx.tooltip.style.bottom = `${window.innerHeight - sy + 8}px`;
  ctx.tooltip.style.top = "";
  ctx.tooltip.style.transform = "translateX(-50%)";
  ctx.tooltip.classList.add("visible");
}

export function hideTooltip(ctx: SelectionContext): void {
  ctx.tooltip.classList.remove("visible");
}

export interface SelectionResult {
  selectedId: string | null;
  selectedIds: Set<string>;
  pendingLine: number | null;
  pendingHighlight: { start: number; end: number } | null;
}

export function applySelection(ctx: SelectionContext, ids: Set<string>): SelectionResult {
  const result: SelectionResult = {
    selectedIds: new Set(ids),
    selectedId: ids.size ? ([...ids].pop() ?? null) : null,
    pendingLine: null,
    pendingHighlight: null,
  };

  if (!ids.size) {
    ctx.inspect.hide();
    ctx.preview.close();
    ctx.right.classList.remove("preview-active");
    ctx.right.classList.remove("visible");
  } else if (ids.size > 1) {
    ctx.right.classList.add("visible");
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const node = ctx.state.nodes.get(id);
      counts[deriveKind(id, node)] = (counts[deriveKind(id, node)] || 0) + 1;
    }
    ctx.inspect.showSummary(counts, ids.size);
    ctx.preview.close();
    ctx.right.classList.remove("preview-active");
  } else {
    const id = result.selectedId as string;
    ctx.right.classList.add("visible");
    const node = ctx.state.nodes.get(id);
    ctx.inspect.show(id, buildMeta(id, node));
    const kind = deriveKind(id, node);
    if (kind !== "folder") {
      const filePath = id.includes("::") ? id.split("::")[0] : id;
      result.pendingLine = kind !== "file" && node?.lines?.start ? node.lines.start : null;
      result.pendingHighlight =
        kind !== "file" && node?.lines ? { start: node.lines.start, end: node.lines.end } : null;
      ctx.sendReadFile(filePath);
      ctx.right.classList.add("preview-active");
    } else {
      ctx.preview.close();
      ctx.right.classList.remove("preview-active");
    }
  }

  return result;
}

export function handleFileContent(
  preview: Preview,
  path: string,
  content: string,
  languageId: string,
  pendingLine: number | null,
  pendingHighlight: { start: number; end: number } | null,
): void {
  preview.open(path, content, languageId);
  if (pendingLine != null) preview.revealLine(pendingLine);
  if (pendingHighlight) {
    preview.highlightLines(pendingHighlight.start, pendingHighlight.end);
  } else {
    preview.clearHighlight();
  }
}
