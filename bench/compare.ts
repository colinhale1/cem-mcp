// Head-to-head: our custom tag-aware fuzzy matcher vs `fuzzysort`.
//
// We compare ONLY on tag-name search — that's where the algorithms differ.
// Description / attribute / event substring scoring is shared between both
// configurations and would just add noise to the comparison.
//
// For each test query we know the expected top-1 tag. We measure:
//   - top-1 hit rate (the expected tag is the #1 result)
//   - top-3 hit rate
//   - mean rank of the expected tag (lower is better; absent = 9999)
//   - median latency over N iterations
//
// Run: `npm run bench` (after `npm run fetch-calcite`).

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fuzzysort from "fuzzysort";

import { CemRegistry, type LoadedPackage } from "../src/cem.js";
import { fuzzySearchTags } from "../src/fuzzy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "../test/fixtures/project");
const PKG = "@esri/calcite-components";

interface Case {
  query: string;
  expect: string; // expected top-1 tag name
  note: string;
}

// Realistic queries an LLM might emit. Each entry pairs a query with the tag
// a human would expect as the top hit. Mix of: exact, common-word, phrasal,
// PascalCase, acronyms, typos, and prefix-stripped forms.
const CASES: Case[] = [
  { query: "calcite-button", expect: "calcite-button", note: "exact" },
  { query: "calcite-date-picker", expect: "calcite-date-picker", note: "exact (multi-token)" },
  { query: "button", expect: "calcite-button", note: "single word" },
  { query: "alert", expect: "calcite-alert", note: "single word" },
  { query: "tooltip", expect: "calcite-tooltip", note: "single word" },
  { query: "tabs", expect: "calcite-tabs", note: "single word" },
  { query: "date picker", expect: "calcite-date-picker", note: "phrasal" },
  { query: "color picker", expect: "calcite-color-picker", note: "phrasal" },
  { query: "action bar", expect: "calcite-action-bar", note: "phrasal" },
  { query: "input number", expect: "calcite-input-number", note: "phrasal" },
  { query: "DatePicker", expect: "calcite-date-picker", note: "PascalCase (no prefix)" },
  { query: "ColorPicker", expect: "calcite-color-picker", note: "PascalCase (no prefix)" },
  { query: "CalciteAlert", expect: "calcite-alert", note: "PascalCase (with prefix)" },
  { query: "datepicker", expect: "calcite-date-picker", note: "concatenated, no separator" },
  { query: "dp", expect: "calcite-date-picker", note: "acronym (prefix stripped)" },
  { query: "cb", expect: "calcite-button", note: "acronym (full)" },
  { query: "alrt", expect: "calcite-alert", note: "typo (drop vowel)" },
  { query: "tooltp", expect: "calcite-tooltip", note: "typo (drop letter)" },
  { query: "buton", expect: "calcite-button", note: "typo (drop letter)" },
  { query: "acordion", expect: "calcite-accordion", note: "typo (drop letter)" },
  { query: "navigaton", expect: "calcite-navigation", note: "typo (drop letter)" },
  { query: "chiip", expect: "calcite-chip", note: "typo (insert letter)" },
];

interface Result {
  query: string;
  expect: string;
  note: string;
  customRank: number;
  fuzzysortRank: number;
}

function rankOf(tags: string[], expected: string): number {
  const i = tags.indexOf(expected);
  return i === -1 ? 9999 : i + 1; // 1-indexed; 9999 = not found
}

async function loadPackage(): Promise<LoadedPackage> {
  if (!existsSync(PROJECT)) {
    console.error(`Fixture missing at ${PROJECT}. Run: npm run fetch-calcite`);
    process.exit(1);
  }
  const reg = await CemRegistry.fromProject(PROJECT);
  return reg.get(PKG);
}

function runCustom(pkg: LoadedPackage, query: string): string[] {
  return fuzzySearchTags(pkg.index, query, pkg.elements.length).map((h) => h.decl.tagName!);
}

function runFuzzysort(pkg: LoadedPackage, query: string): string[] {
  // Apples-to-apples: single-key search against tag names. We could feed
  // fuzzysort multiple keys (description, attributes, ...) too, but our
  // custom matcher is also tag-only at this stage — combining them would
  // muddy the comparison. Description-level substring matching is shared
  // downstream in cem.ts and not part of this measurement.
  const targets = pkg.elements.map((d) => d.tagName!);
  const results = fuzzysort.go(query, targets, { limit: targets.length });
  return results.map((r) => r.target);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function timeRun(fn: () => unknown, iters: number): number {
  const samples: number[] = [];
  // warmup
  for (let i = 0; i < 5; i++) fn();
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return median(samples);
}

async function main(): Promise<void> {
  const pkg = await loadPackage();
  console.log(`Loaded ${pkg.name}@${pkg.version} — ${pkg.elements.length} components`);
  console.log(`Common prefix detected: "${pkg.prefix}"\n`);

  const rows: Result[] = [];
  let cust1 = 0;
  let cust3 = 0;
  let fuzz1 = 0;
  let fuzz3 = 0;
  const custRanks: number[] = [];
  const fuzzRanks: number[] = [];

  for (const c of CASES) {
    const custTags = runCustom(pkg, c.query);
    const fuzzTags = runFuzzysort(pkg, c.query);
    const cr = rankOf(custTags, c.expect);
    const fr = rankOf(fuzzTags, c.expect);
    rows.push({
      query: c.query,
      expect: c.expect,
      note: c.note,
      customRank: cr,
      fuzzysortRank: fr,
    });
    if (cr === 1) cust1++;
    if (cr <= 3) cust3++;
    if (fr === 1) fuzz1++;
    if (fr <= 3) fuzz3++;
    custRanks.push(cr === 9999 ? 9999 : cr);
    fuzzRanks.push(fr === 9999 ? 9999 : fr);
  }

  const n = CASES.length;
  const fmt = (n: number, d: number) => `${((n / d) * 100).toFixed(0)}% (${n}/${d})`;

  console.log("Per-query ranks (lower is better, 9999 = not in results):\n");
  console.log(
    "  " + ["query".padEnd(22), "expected".padEnd(26), "custom", "fuzzysort", "note"].join("  "),
  );
  for (const r of rows) {
    const mark = (rank: number) => (rank === 1 ? "✓" : rank <= 3 ? "·" : "✗");
    console.log(
      "  " +
        [
          r.query.padEnd(22),
          r.expect.padEnd(26),
          `${mark(r.customRank)} ${String(r.customRank).padStart(4)}`.padEnd(6),
          `${mark(r.fuzzysortRank)} ${String(r.fuzzysortRank).padStart(4)}`.padEnd(9),
          r.note,
        ].join("  "),
    );
  }

  const meanRank = (rs: number[]) =>
    (rs.reduce((a, b) => a + (b === 9999 ? 50 : b), 0) / rs.length).toFixed(2);

  console.log("\nQuality:");
  console.log(
    `  custom    top-1=${fmt(cust1, n)}  top-3=${fmt(cust3, n)}  mean-rank=${meanRank(custRanks)}`,
  );
  console.log(
    `  fuzzysort top-1=${fmt(fuzz1, n)}  top-3=${fmt(fuzz3, n)}  mean-rank=${meanRank(fuzzRanks)}`,
  );

  // Latency: amortize over all cases.
  const iters = 200;
  const tCustom = timeRun(() => {
    for (const c of CASES) runCustom(pkg, c.query);
  }, iters);
  const tFuzz = timeRun(() => {
    for (const c of CASES) runFuzzysort(pkg, c.query);
  }, iters);
  console.log("\nLatency (median over " + iters + " iters, all cases per iter):");
  console.log(
    `  custom    ${tCustom.toFixed(3)} ms  (${(tCustom / CASES.length).toFixed(3)} ms/query)`,
  );
  console.log(
    `  fuzzysort ${tFuzz.toFixed(3)} ms  (${(tFuzz / CASES.length).toFixed(3)} ms/query)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
