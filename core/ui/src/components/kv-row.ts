import { el } from "../dom";

export function KVRow(key: string, value: string): HTMLElement {
  return el(
    "div",
    { className: "kv-row" },
    el("span", { className: "kv-key" }, key),
    el("span", { className: "kv-val" }, value),
  );
}
