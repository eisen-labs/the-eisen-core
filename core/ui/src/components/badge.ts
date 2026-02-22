import { el } from "../dom";

export function Badge(text: string, color?: string): HTMLElement {
  const span = el("span", { className: "badge" }, text);
  if (color) {
    span.style.color = color;
    span.style.background = color.replace("rgb(", "rgba(").replace(")", ",0.14)");
  }
  return span;
}
