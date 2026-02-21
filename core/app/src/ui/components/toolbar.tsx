// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";
import { ICON } from "../panels/icons";

export interface ToolbarCb {
  onView(): void;
  onLayers(): void;
  onFit(): void;
  onMarquee(): void;
  onDeps(): void;
}

const BUTTONS: Array<{ key: keyof ToolbarCb; icon: string; title: string }> = [
  { key: "onView", icon: ICON.view, title: "Cycle view mode" },
  { key: "onLayers", icon: ICON.layers, title: "Cycle region depth" },
  { key: "onFit", icon: ICON.fit, title: "Fit view" },
  { key: "onMarquee", icon: ICON.marquee, title: "Selection mode" },
  { key: "onDeps", icon: ICON.deps, title: "Show deps" },
];

export class Toolbar {
  el: HTMLElement;

  constructor(cb: ToolbarCb) {
    this.el = (
      <div className="flex items-center gap-0.5 bg-raised backdrop-blur-xl border border-border-subtle rounded-xl p-1" />
    ) as HTMLElement;
    for (const b of BUTTONS) {
      const btn = (
        <button
          type="button"
          className="w-8 h-8 p-1.5 border-none bg-transparent text-muted rounded-lg flex items-center justify-center cursor-pointer hover:text-foreground hover:bg-raised [&>svg]:w-full [&>svg]:h-full"
          tabIndex={-1}
          innerHTML={b.icon}
          title={b.title}
        />
      ) as HTMLButtonElement;
      btn.addEventListener("click", () => cb[b.key]());
      this.el.append(btn);
    }
  }
}
