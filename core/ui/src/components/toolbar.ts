import { el } from "../dom";
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
    this.el = el("div", { className: "toolbar" });
    for (const b of BUTTONS) {
      const btn = el("button", {
        type: "button",
        className: "icon-btn",
        tabIndex: -1,
        innerHTML: b.icon,
        title: b.title,
        "aria-label": b.title,
      });
      btn.addEventListener("click", () => cb[b.key]());
      this.el.append(btn);
    }
  }
}
