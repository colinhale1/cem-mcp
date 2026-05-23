// Custom fuzzy matcher tuned for the shape of web-component tag names.
//
// Tag names are always kebab-case and almost always share a common prefix
// within a library (e.g. every Calcite tag starts with "calcite-"). LLMs
// will plausibly type any of: the kebab tag, the bare name without the
// prefix, a PascalCase form ("DatePicker"), an acronym ("dp"), a phrase
// ("date picker"), or a truncated/typo'd form ("dpicker", "alrt").
//
// At index build time we precompute every "form" we can match against, then
// at query time we generate the same forms from the input and look for the
// best-scoring overlap. The result is a tiny, dependency-free matcher that
// outperforms generic char-level fuzzies on this specific dataset — see
// docs/adr-0001-fuzzy-search.md for the measurements.

import type { CemDeclaration } from "./cem.js";

export interface TagIndex {
  decl: CemDeclaration;
  tag: string;
  tokens: string[]; // kebab tokens, all
  shortTokens: string[]; // tokens with the library-wide common prefix dropped
  acronym: string; // first letters of tokens
  shortAcronym: string; // first letters of shortTokens
  flat: string; // tokens.join("") — "calcitedatepicker"
  shortFlat: string; // shortTokens.join("") — "datepicker"
  pascal: string; // CalciteDatePicker
  shortPascal: string; // DatePicker
}

export interface FuzzyMatch {
  decl: CemDeclaration;
  score: number;
  reasons: string[];
}

const kebabTokens = (tag: string): string[] => tag.split("-").filter(Boolean);

const toPascal = (tokens: string[]): string =>
  tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join("");

const acronym = (tokens: string[]): string =>
  tokens.map((t) => t.charAt(0)).join("");

// Capped Levenshtein distance. Used for typo tolerance on short strings;
// returns `cap + 1` (any value > cap) as soon as we can prove the answer
// exceeds cap, so callers can early-reject without paying for the full edit.
//
// Note: we do NOT include the Damerau transposition step here. Implementing
// Damerau correctly with the rolling two-row buffer would require a third
// row (row i-2). The transposition case ("buttno" vs "button") is a less
// common LLM typo than insertion/deletion, and a buggy Damerau is much worse
// than no Damerau: stale values pulled from `prev[j-2]` (which holds row
// i-1, not i-2) can make the answer artificially small on strings with
// repeated characters, manifesting as "distance 0" for clearly different
// strings. See docs/adr-0001-fuzzy-search.md.
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl]!;
}

// Find the kebab prefix shared by the majority of tags (≥60%). If none
// dominates we return an empty string — short-form matching simply degrades
// to the full-form scoring.
function commonPrefix(tags: string[]): string {
  if (tags.length === 0) return "";
  const counts = new Map<string, number>();
  for (const tag of tags) {
    const first = kebabTokens(tag)[0];
    if (!first) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [tok, n] of counts) {
    if (n > bestN) {
      best = tok;
      bestN = n;
    }
  }
  return bestN / tags.length >= 0.6 ? best : "";
}

export function buildIndex(decls: CemDeclaration[]): {
  index: TagIndex[];
  prefix: string;
} {
  const tags = decls.map((d) => d.tagName ?? "").filter(Boolean);
  const prefix = commonPrefix(tags);
  const index: TagIndex[] = [];
  for (const decl of decls) {
    const tag = decl.tagName;
    if (!tag) continue;
    const tokens = kebabTokens(tag);
    const shortTokens = prefix && tokens[0] === prefix ? tokens.slice(1) : tokens;
    index.push({
      decl,
      tag,
      tokens,
      shortTokens,
      acronym: acronym(tokens),
      shortAcronym: acronym(shortTokens),
      flat: tokens.join(""),
      shortFlat: shortTokens.join(""),
      pascal: toPascal(tokens),
      shortPascal: toPascal(shortTokens),
    });
  }
  return { index, prefix };
}

// Normalize a user query to a canonical bag of "forms" we can compare against
// each indexed tag. We don't try to be clever — we just produce a few
// equivalent shapes and let the scoring step pick the best match.
function queryShapes(raw: string): {
  lower: string;
  flat: string; // no separators, lowercase
  tokens: string[]; // lowercase, split on -, _, space, camel boundary
} {
  const lower = raw.trim().toLowerCase();
  const tokens = raw
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camel → spaces
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const flat = tokens.join("");
  return { lower, flat, tokens };
}

export function fuzzySearchTags(
  index: TagIndex[],
  query: string,
  limit = 20,
): FuzzyMatch[] {
  const q = queryShapes(query);
  if (!q.lower) return [];

  const hits: FuzzyMatch[] = [];

  for (const entry of index) {
    let score = 0;
    const reasons: string[] = [];

    // 1. Exact matches across forms. Highest tier; we still score lower forms
    //    too so the reasons are informative.
    if (entry.tag === q.lower) {
      score += 1000;
      reasons.push("tag exact");
    }
    if (entry.flat === q.flat) {
      score += 600;
      reasons.push("flat exact");
    }
    if (entry.shortFlat && entry.shortFlat === q.flat) {
      score += 500;
      reasons.push("short flat exact (prefix-stripped)");
    }
    if (entry.pascal.toLowerCase() === q.flat) {
      score += 500;
      reasons.push("pascal exact");
    }
    if (entry.shortPascal && entry.shortPascal.toLowerCase() === q.flat) {
      score += 450;
      reasons.push("short pascal exact");
    }

    // 2. Acronym matches — "dp" → date-picker. Only meaningful for queries
    //    short enough to plausibly be an acronym (<=5 chars, no spaces).
    if (q.flat.length >= 2 && q.flat.length <= 5 && q.tokens.length === 1) {
      if (entry.acronym === q.flat) {
        score += 300;
        reasons.push(`acronym: ${entry.acronym}`);
      }
      if (entry.shortAcronym && entry.shortAcronym === q.flat) {
        score += 280;
        reasons.push(`short acronym: ${entry.shortAcronym}`);
      }
    }

    // 3. Token-set overlap — every query token is a token of the tag.
    if (q.tokens.length > 0) {
      const tagTokenSet = new Set(entry.tokens);
      const shortTokenSet = new Set(entry.shortTokens);
      const allInTag = q.tokens.every((t) => tagTokenSet.has(t));
      const allInShort = q.tokens.every((t) => shortTokenSet.has(t));
      if (allInTag) {
        // Reward when the query covers most of the tag (fewer extra tokens).
        const coverage = q.tokens.length / entry.tokens.length;
        score += 200 + Math.round(50 * coverage);
        reasons.push(`all tokens in tag (coverage ${coverage.toFixed(2)})`);
      } else if (allInShort) {
        const coverage = q.tokens.length / Math.max(entry.shortTokens.length, 1);
        score += 180 + Math.round(40 * coverage);
        reasons.push(`all tokens in short tag (coverage ${coverage.toFixed(2)})`);
      } else {
        // Partial token-set: at least one query token matches a tag token.
        const matched = q.tokens.filter((t) => tagTokenSet.has(t)).length;
        if (matched > 0) {
          score += 30 * matched;
          reasons.push(`${matched}/${q.tokens.length} tokens match a tag token`);
        }
      }
    }

    // 4. Substring containment (across forms). Catches "button" in
    //    "split-button" without needing token-set membership.
    if (q.lower.length >= 2) {
      if (entry.tag.includes(q.lower)) {
        score += 40;
        reasons.push("tag contains query");
      }
      if (entry.flat.includes(q.flat)) {
        score += 20;
        reasons.push("flat contains query");
      }
      if (entry.shortFlat && entry.shortFlat.includes(q.flat)) {
        score += 30;
        reasons.push("short flat contains query");
      }
    }

    // 5. Typo tolerance — distance up to 2 against the flat or short-flat
    //    form, for queries long enough to make a typo plausible.
    if (q.flat.length >= 4) {
      const cap = q.flat.length <= 5 ? 1 : 2;
      const dFlat = editDistance(q.flat, entry.flat, cap);
      if (dFlat <= cap && dFlat > 0) {
        score += 120 - 30 * dFlat;
        reasons.push(`flat edit-distance ${dFlat}`);
      } else if (entry.shortFlat) {
        const dShort = editDistance(q.flat, entry.shortFlat, cap);
        if (dShort <= cap && dShort > 0) {
          score += 110 - 30 * dShort;
          reasons.push(`short flat edit-distance ${dShort}`);
        }
      }
    }

    if (score > 0) hits.push({ decl: entry.decl, score, reasons });
  }

  hits.sort((a, b) => b.score - a.score || a.decl.tagName!.localeCompare(b.decl.tagName!));
  return hits.slice(0, limit);
}
