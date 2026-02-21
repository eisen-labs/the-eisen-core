import { el } from "../dom";
import { Badge } from "./badge";
import { KVRow } from "./kv-row";

export interface NodeMeta {
  kind: string;
  lines?: string;
  tokens?: string;
  action?: string;
  agents?: string;
}

export class Inspect {
  el: HTMLElement;
  private content: HTMLElement;

  constructor() {
    this.content = el("div", { className: "inspect-body" });
    this.el = el("div", { className: "inspect-scroll" });
    this.el.append(this.content);
  }

  show(id: string, meta: NodeMeta): void {
    this.content.innerHTML = "";

    const label = id.includes("::") ? (id.split("::").pop() as string) : id.split("/").pop() || "/";

    this.content.append(
      el("div", { className: "inspect-header" }, Badge(meta.kind), el("span", { className: "inspect-label" }, label)),
    );

    if (meta.lines) this.content.append(KVRow("lines", meta.lines));
    if (meta.tokens) this.content.append(KVRow("tokens", meta.tokens));
    if (meta.action) this.content.append(KVRow("action", meta.action));
    if (meta.agents) this.content.append(KVRow("agents", meta.agents));

    this.content.append(el("div", { className: "inspect-footer" }, el("span", { className: "inspect-path" }, id)));
  }

  hide(): void {
    this.content.innerHTML = "";
  }
}
