import { el } from "../../ui/src/dom";
import { getRecent } from "./store";
import { open } from "@tauri-apps/plugin-dialog";

const MARK = '<svg class="welcome-mark" viewBox="0 0 306 180" fill="none" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M153 111.737L59.5283 180L95.5 69.5L112.206 81.6987L97.4355 127.55L136.088 99.3217L153 111.737Z"/>'
  + '<path d="M306 0.0322266L211.064 70.083L246.472 180L0 0L306 0.0322266ZM208.564 127.55L187.619 62.5273L245.219 20.0254L61.3057 20.0059L208.564 127.55Z"/>'
  + '</svg>';


const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';

export interface WelcomeCb {
  onOpen(path: string): void;
}

export class Welcome {
  el: HTMLElement;
  private mark!: SVGSVGElement;
  private content!: HTMLElement;
  private recentList: HTMLElement;
  private cb: WelcomeCb;

  constructor(cb: WelcomeCb) {
    this.cb = cb;

    const tmp = document.createElement("div");
    tmp.innerHTML = MARK;
    this.mark = tmp.firstElementChild as SVGSVGElement;

    this.content = el("div", { className: "welcome-content" });

    const openBtn = el("button", { type: "button", className: "welcome-btn" });
    openBtn.innerHTML = ICON_FOLDER + "Open Folder";
    openBtn.addEventListener("click", () => this.handleOpenFolder());

    this.recentList = el("div", { className: "recent-list" });
    this.content.append(openBtn, this.recentList);

    const inner = el("div", { className: "welcome-inner" });
    inner.append(this.mark, this.content);

    this.el = el("div", { className: "welcome" });
    this.el.append(inner);

    this.animate();
    this.loadRecent();
  }

  private animate() {
    const paths = this.mark.querySelectorAll("path");

    requestAnimationFrame(() => {
      for (const p of paths) {
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len}`;
        p.style.strokeDashoffset = `${len}`;
      }
      this.mark.getBoundingClientRect();

      this.mark.classList.add("drawing");
      for (const p of paths) p.style.strokeDashoffset = "0";

      setTimeout(() => {
        this.mark.classList.replace("drawing", "drawn");
      }, 1300);

      setTimeout(() => this.content.classList.add("visible"), 1800);
    });
  }


  private async loadRecent() {
    const workspaces = await getRecent();
    if (workspaces.length === 0) return;

    this.recentList.append(el("hr", { className: "welcome-sep" }));

    for (const w of workspaces.slice(0, 5)) {
      const btn = el("button", { type: "button", className: "welcome-btn" }, w.name);
      btn.addEventListener("click", () => this.cb.onOpen(w.path));
      this.recentList.append(btn);
    }
  }

  private async handleOpenFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      this.cb.onOpen(selected);
    }
  }
}
