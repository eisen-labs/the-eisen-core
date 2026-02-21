import { el } from "../dom";

export function Badge(text: string): HTMLElement {
  return el("span", { className: "badge" }, text);
}
