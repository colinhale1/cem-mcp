import { cem2Adapter } from "./cem2.js";
import { carbonHtmlDataAdapter } from "./carbon-html-data.js";
import type { CemAdapter } from "./types.js";

export type { CemAdapter } from "./types.js";

// Order matters: the first adapter whose `matches()` returns true wins. The
// standard CEM 2.x adapter comes first so a file with both `modules` and any
// other top-level keys is always treated as a real CEM rather than misread by
// a more permissive adapter.
export const builtinAdapters: ReadonlyArray<CemAdapter> = [cem2Adapter, carbonHtmlDataAdapter];

export function selectAdapters(
  all: ReadonlyArray<CemAdapter>,
  disable: ReadonlyArray<string> = [],
): CemAdapter[] {
  const skip = new Set(disable);
  return all.filter((a) => !skip.has(a.name));
}

export function findAdapter(
  adapters: ReadonlyArray<CemAdapter>,
  parsed: unknown,
): CemAdapter | null {
  for (const a of adapters) {
    try {
      if (a.matches(parsed)) return a;
    } catch {
      // Defensive: a buggy matcher must not break discovery for other packages.
    }
  }
  return null;
}
