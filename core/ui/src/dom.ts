type Props = Record<string, unknown> | null;
type Child = Node | string | number | boolean | null | undefined;

export function el(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "className") e.className = v as string;
      else if (k === "innerHTML") e.innerHTML = v as string;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k === "tabIndex") e.tabIndex = v as number;
      else e.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
