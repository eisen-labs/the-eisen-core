export function makeKVRow(key: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "info-kv";
  const k = document.createElement("span");
  k.className = "info-kv-key";
  k.textContent = key;
  const v = document.createElement("span");
  v.className = "info-kv-val";
  v.textContent = value;
  row.append(k, v);
  return row;
}

export function makeBadge(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "ui-badge";
  span.textContent = text;
  return span;
}

export function makeDivider(): HTMLHRElement {
  const hr = document.createElement("hr");
  hr.style.border = "none";
  hr.style.borderTop = "1px solid var(--ui-border-subtle)";
  hr.style.margin = "4px 0";
  return hr;
}
