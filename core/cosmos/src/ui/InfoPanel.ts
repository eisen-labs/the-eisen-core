import type { NodeMeta } from "../graph-data";
import { makeBadge, makeKVRow } from "./components";

export class InfoPanel {
  private el: HTMLElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "info-panel";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  update(id: string | null, meta: NodeMeta | null): void {
    if (!id || !meta) {
      this.el.style.display = "none";
      return;
    }

    this.el.innerHTML = "";

    const label = id.includes("::") ? id.split("::").pop()! : id.split("/").pop() || "/";

    const header = document.createElement("div");
    header.className = "info-panel-header";
    header.append(makeBadge(meta.kind));
    const name = document.createElement("span");
    name.className = "info-panel-label";
    name.textContent = label;
    header.append(name);
    this.el.append(header);

    if (meta.lines) {
      const count = meta.lines.end - meta.lines.start + 1;
      this.el.append(makeKVRow("lines", `${meta.lines.start}-${meta.lines.end} (${count})`));
    }
    if (meta.tokens != null) {
      this.el.append(makeKVRow("tokens", meta.tokens.toLocaleString()));
    }
    if (meta.lastAction) {
      this.el.append(makeKVRow("action", meta.lastAction));
    }
    if (meta.inContext) {
      this.el.append(makeKVRow("context", "yes"));
    }

    if (meta.agentHeat) {
      const agents = Object.entries(meta.agentHeat).filter(([, h]) => h > 0);
      if (agents.length > 0) {
        this.el.append(makeKVRow("agents", agents.map(([n]) => n).join(", ")));
      }
    }

    if (meta.agentContext) {
      const inCtx = Object.entries(meta.agentContext).filter(([, v]) => v);
      if (inCtx.length > 0) {
        this.el.append(makeKVRow("in ctx of", inCtx.map(([n]) => n).join(", ")));
      }
    }

    const path = document.createElement("div");
    path.className = "info-panel-path";
    path.textContent = id;
    this.el.append(path);

    this.el.style.display = "block";
  }

  destroy(): void {
    this.el.remove();
  }
}
