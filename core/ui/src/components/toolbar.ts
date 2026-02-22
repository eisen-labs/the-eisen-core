import { el } from "../dom";
import { ICON } from "../panels/icons";

export interface ToolbarCb {
  onView(): void;
  onLayers(): void;
  onFit(): void;
  onMarquee(): void;
  onDeps(): void;
}

export class Toolbar {
  el: HTMLElement;
  private marqueeBtn: HTMLElement;
  private isLasso = false;

  constructor(cb: ToolbarCb) {
    this.el = el("div", { className: "toolbar glass" });

    const left = el("div", { className: "toolbar-group" });

    const mkBtn = (icon: string, title: string, onClick: () => void) => {
      const btn = el("button", {
        type: "button",
        className: "icon-btn",
        tabIndex: -1,
        innerHTML: icon,
        title,
        "aria-label": title,
      });
      btn.addEventListener("click", onClick);
      return btn;
    };

    this.marqueeBtn = mkBtn(ICON.marquee, "Selection mode", () => {
      cb.onMarquee();
      this.isLasso = !this.isLasso;
      this.marqueeBtn.innerHTML = this.isLasso ? ICON.lasso : ICON.marquee;
      this.marqueeBtn.title = this.isLasso ? "Lasso select" : "Marquee select";
    });

    left.append(
      mkBtn(ICON.view, "Cycle view mode", () => cb.onView()),
      mkBtn(ICON.layers, "Cycle region depth", () => cb.onLayers()),
      mkBtn(ICON.fit, "Fit view", () => cb.onFit()),
      this.marqueeBtn,
    );

    const depsBtn = mkBtn(ICON.deps, "Show deps", () => {
      depsBtn.classList.toggle("active");
      cb.onDeps();
    });

    const sep = el("div", { className: "toolbar-sep" });
    this.el.append(left, sep, depsBtn);
  }
}
