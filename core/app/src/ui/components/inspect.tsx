// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";
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
    this.content = (<div className="p-4" />) as HTMLElement;
    this.el = (<div className="h-full overflow-y-auto" />) as HTMLElement;
    this.el.append(this.content);
  }

  show(id: string, meta: NodeMeta): void {
    this.content.innerHTML = "";

    const label = id.includes("::") ? (id.split("::").pop() as string) : id.split("/").pop() || "/";

    this.content.append(
      (
        <div className="flex items-center gap-2.5 mb-3 min-w-0">
          {Badge(meta.kind)}
          <span className="text-foreground text-md font-medium overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            {label}
          </span>
        </div>
      ) as HTMLElement,
    );

    if (meta.lines) this.content.append(KVRow("lines", meta.lines));
    if (meta.tokens) this.content.append(KVRow("tokens", meta.tokens));
    if (meta.action) this.content.append(KVRow("action", meta.action));
    if (meta.agents) this.content.append(KVRow("agents", meta.agents));

    this.content.append(
      (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          <span className="text-xs text-faint font-mono overflow-hidden text-ellipsis whitespace-nowrap block">
            {id}
          </span>
        </div>
      ) as HTMLElement,
    );
  }

  hide(): void {
    this.content.innerHTML = "";
  }
}
