// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";

export function KVRow(key: string, value: string): HTMLDivElement {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-faint text-sm shrink-0">{key}</span>
      <span className="text-foreground text-sm">{value}</span>
    </div>
  ) as HTMLDivElement;
}
