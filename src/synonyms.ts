import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WeightedTerm } from "./bm25.js";
import { stem } from "./text.js";

// Load the starter synonym map via fs rather than `import ... from "./synonyms.json"`.
// JSON imports under Node's ESM loader require an `assert`/`with` attribute
// (`with { type: "json" }`), but emitting that attribute requires bumping the
// TS `module` target. Reading the file at module init time keeps the source
// portable across TS versions and Node 18+ without any extra ceremony.
const here = dirname(fileURLToPath(import.meta.url));
const builtinData = JSON.parse(
  readFileSync(resolve(here, "./synonyms.json"), "utf8"),
) as SynonymsData;

export interface SynonymsData {
  version: number;
  synonyms: Record<string, string[]>;
}

// Default weight for a synonym-expanded query term, relative to the original
// term's weight of 1.0. Tuned so that a strong literal match still outranks a
// synonym chain — "alert" in the query is worth more than "alert" reached by
// expanding from "toast".
const DEFAULT_SYNONYM_WEIGHT = 0.6;

// Build a closed, bidirectional synonym map from a one-directional declaration.
// `{ "toast": ["alert"] }` becomes `{ "toast": ["alert"], "alert": ["toast"] }`.
// We intentionally do NOT compute transitive closure — that runs away fast on
// dense cluster (every synonym of every synonym becomes a synonym of the
// original) and amplifies noisy mappings. If you want "toast" → "warning" you
// declare both pairs explicitly.
export function buildSynonymMap(
  base: SynonymsData = builtinData as SynonymsData,
  extend: Record<string, string[]> = {},
  disable = false,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (disable && Object.keys(extend).length === 0) return map;

  const source = disable ? extend : { ...base.synonyms, ...extend };

  const addEdge = (a: string, b: string): void => {
    if (a === b) return;
    const arr = map.get(a) ?? [];
    if (!arr.includes(b)) arr.push(b);
    map.set(a, arr);
  };

  // Stem both keys and values so the map collides with stemmed query tokens.
  // "loading" in the query stems to "load"; if the map says
  // "spinner ↔ loading", we need "spinner ↔ load" so the lookup hits.
  for (const [rawKey, vals] of Object.entries(source)) {
    const key = stem(rawKey);
    for (const rawVal of vals) {
      const val = stem(rawVal);
      addEdge(key, val);
      addEdge(val, key);
    }
  }
  return map;
}

// Expand a tokenized query into a bag of weighted terms: every original token
// at weight 1.0, every synonym at `synonymWeight`. Deduplicates so a token
// reached by multiple paths is only scored once (the higher weight wins).
export function expandQuery(
  tokens: string[],
  synonyms: Map<string, string[]>,
  synonymWeight = DEFAULT_SYNONYM_WEIGHT,
): WeightedTerm[] {
  const best = new Map<string, number>();
  for (const t of tokens) best.set(t, Math.max(best.get(t) ?? 0, 1));
  for (const t of tokens) {
    for (const syn of synonyms.get(t) ?? []) {
      best.set(syn, Math.max(best.get(syn) ?? 0, synonymWeight));
    }
  }
  return Array.from(best, ([term, weight]) => ({ term, weight }));
}
