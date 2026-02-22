const LOGO_SVG = `<svg viewBox="0 0 220 129" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M189.53 10.0195L145.82 42.1699L140.014 46.4414L142.23 53.3008L158.232 102.821L30.7324 10.0029L189.53 10.0195Z" fill="currentColor" stroke="currentColor" stroke-width="20"/>
</svg>`;

export class LogoButton {
  private el: HTMLElement;

  constructor(onFitView: () => void) {
    this.el = document.createElement("div");
    this.el.className = "logo-button";
    this.el.innerHTML = LOGO_SVG;
    this.el.addEventListener("click", onFitView);
    document.body.appendChild(this.el);
  }

  destroy(): void {
    this.el.remove();
  }
}
