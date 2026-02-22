import * as path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".git",
  ".venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
  ".output",
  "out",
]);

export function isIgnoredPath(filePath: string): boolean {
  return filePath
    .split("/")
    .some((s) => (s.startsWith(".") && s !== ".." && s !== ".") || IGNORED_DIRS.has(s));
}

export function toWorkspaceRelative(filePath: string, cwd: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (!cwd || !path.isAbsolute(filePath)) {
    return normalized.replace(/^\.\//, "");
  }
  return path.relative(cwd, filePath).replaceAll(path.sep, "/").replace(/^\.\//, "");
}

export function normalizeNodeId(rawId: string, cwd: string): string {
  const [filePart, ...symbolParts] = rawId.split("::");
  const file = toWorkspaceRelative(filePart, cwd);
  if (!file) return "";
  if (isIgnoredPath(file)) return "";
  return symbolParts.length === 0 ? file : `${file}::${symbolParts.join("::")}`;
}

export function normalizeAction(action?: string): "read" | "write" | "search" {
  if (action === "write") return "write";
  if (action === "search") return "search";
  return "read";
}

export function toMergedSnapshot(
  msg: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const rawNodes = msg?.nodes;
  if (rawNodes && typeof rawNodes === "object") {
    for (const [rawPath, node] of Object.entries(rawNodes as Record<string, Record<string, unknown>>)) {
      const id = normalizeNodeId(rawPath, cwd);
      if (!id) continue;
      const action = normalizeAction(node?.last_action as string | undefined);
      nodes[id] = {
        inContext: Boolean(node?.in_context),
        changed: action === "write",
        lastAction: action,
      };
    }
  }
  return {
    type: "mergedSnapshot",
    seq: (msg?.seq as number) ?? 0,
    nodes,
    calls: [],
  };
}

export function toMergedDelta(
  msg: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const updates: Array<Record<string, unknown>> = [];
  const rawUpdates = msg?.updates;
  if (Array.isArray(rawUpdates)) {
    for (const u of rawUpdates) {
      const id = normalizeNodeId(u?.path, cwd);
      if (!id) continue;
      const action = normalizeAction(u?.last_action);
      updates.push({
        id,
        action,
        inContext: u?.in_context,
        changed: action === "write",
      });
    }
  }
  const rawRemoved = msg?.removed;
  if (Array.isArray(rawRemoved)) {
    for (const rawPath of rawRemoved) {
      const id = normalizeNodeId(rawPath, cwd);
      if (id) updates.push({ id, action: "remove" });
    }
  }
  return {
    type: "mergedDelta",
    seq: (msg?.seq as number) ?? 0,
    updates,
  };
}
