type Child = Node | string | number | boolean | null | undefined;

export function h(tag: string, props: Record<string, unknown> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);

  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val == null || val === false) continue;
      if (key === "className") {
        el.className = val as string;
      } else if (key === "innerHTML") {
        el.innerHTML = val as string;
      } else if (key === "style" && typeof val === "object") {
        Object.assign(el.style, val);
      } else if (key.startsWith("on") && typeof val === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (key === "tabIndex") {
        el.tabIndex = val as number;
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }

  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }

  return el;
}

export function Fragment(_props: null, ...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (child instanceof Node) {
      frag.appendChild(child);
    } else {
      frag.appendChild(document.createTextNode(String(child)));
    }
  }
  return frag;
}
