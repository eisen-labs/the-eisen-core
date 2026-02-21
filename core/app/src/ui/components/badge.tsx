// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";

export function Badge(text: string): HTMLSpanElement {
  return (
    <span className="inline-block px-2 py-0.5 rounded-lg bg-accent-muted text-accent text-xs font-medium">{text}</span>
  ) as HTMLSpanElement;
}
