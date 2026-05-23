// Cross-library bench. For every discovered package, synthesize a query test
// set from the tag list itself, then run both matchers and report per-library
// quality + the misses (so we can see what categories of query break the
// matcher across naming conventions).
//
// Synthetic queries per tag (only kept when they unambiguously map back to
// the source tag within the library — i.e. no other tag shares the same
// generated form):
//   - exact:   the kebab tag itself
//   - short:   tag with library-wide common prefix dropped (e.g. "date-picker"
//              for "calcite-date-picker"). Skipped if no detected prefix.
//   - pascal:  PascalCase of the short form ("DatePicker")
//   - flat:    short form without separators ("datepicker")
//   - typo-drop: short flat with one middle letter dropped ("dtepicker")
//   - typo-ins:  short flat with one duplicated letter ("ddatepicker")
//
// Run: `npm run bench:multi` after `npm run fetch-libs`.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fuzzysort from "fuzzysort";

import { CemRegistry, type LoadedPackage } from "../src/cem.js";
import { fuzzySearchTags, type TagIndex } from "../src/fuzzy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "../test/fixtures/project");

type CaseKind = "exact" | "short" | "pascal" | "flat" | "typo-drop" | "typo-ins";

interface Case {
  kind: CaseKind;
  query: string;
  expect: string;
}

function uniqueShortFlat(index: TagIndex[]): Set<string> {
  const counts = new Map<string, number>();
  for (const e of index) counts.set(e.shortFlat, (counts.get(e.shortFlat) ?? 0) + 1);
  const unique = new Set<string>();
  for (const [k, n] of counts) if (n === 1) unique.add(k);
  return unique;
}

function generateCases(pkg: LoadedPackage): Case[] {
  const cases: Case[] = [];
  const uniqueShort = uniqueShortFlat(pkg.index);

  for (const entry of pkg.index) {
    const tag = entry.tag;
    cases.push({ kind: "exact", query: tag, expect: tag });

    const hasShortForm = entry.shortTokens.length !== entry.tokens.length;
    const shortIsUnique = uniqueShort.has(entry.shortFlat);

    if (hasShortForm && shortIsUnique) {
      cases.push({ kind: "short", query: entry.shortTokens.join("-"), expect: tag });
      cases.push({ kind: "pascal", query: entry.shortPascal, expect: tag });
      cases.push({ kind: "flat", query: entry.shortFlat, expect: tag });

      if (entry.shortFlat.length >= 5) {
        const mid = Math.floor(entry.shortFlat.length / 2);
        const dropped = entry.shortFlat.slice(0, mid) + entry.shortFlat.slice(mid + 1);
        cases.push({ kind: "typo-drop", query: dropped, expect: tag });

        const inserted = entry.shortFlat[0] + entry.shortFlat;
        cases.push({ kind: "typo-ins", query: inserted, expect: tag });
      }
    } else if (!hasShortForm) {
      // No detectable common prefix — exercise PascalCase / flat on the full tag.
      const full = entry.tokens.join("");
      if (full.length >= 4) {
        cases.push({ kind: "flat", query: full, expect: tag });
        cases.push({ kind: "pascal", query: entry.pascal, expect: tag });
      }
    }
  }
  return cases;
}

function rankOf(tags: string[], expected: string): number {
  const i = tags.indexOf(expected);
  return i === -1 ? 9999 : i + 1;
}

function runCustom(pkg: LoadedPackage, query: string): string[] {
  return fuzzySearchTags(pkg.index, query, pkg.elements.length).map((h) => h.decl.tagName!);
}

function runFuzzysort(targets: string[], query: string): string[] {
  return fuzzysort.go(query, targets, { limit: targets.length }).map((r) => r.target);
}

interface Tally {
  total: number;
  cust1: number;
  cust3: number;
  fuzz1: number;
  fuzz3: number;
  byKind: Map<CaseKind, { total: number; cust1: number; fuzz1: number }>;
  misses: Array<{ kind: CaseKind; query: string; expect: string; cr: number; fr: number }>;
}

function emptyTally(): Tally {
  return { total: 0, cust1: 0, cust3: 0, fuzz1: 0, fuzz3: 0, byKind: new Map(), misses: [] };
}

function bumpKind(t: Tally, kind: CaseKind, cust: boolean, fuzz: boolean): void {
  const bucket = t.byKind.get(kind) ?? { total: 0, cust1: 0, fuzz1: 0 };
  bucket.total++;
  if (cust) bucket.cust1++;
  if (fuzz) bucket.fuzz1++;
  t.byKind.set(kind, bucket);
}

const pad = (s: string, n: number) => s.padEnd(n);
const padN = (n: number, w: number) => String(n).padStart(w);
const pct = (n: number, d: number) => (d === 0 ? "  —  " : `${((n / d) * 100).toFixed(0).padStart(3)}%`);

async function main(): Promise<void> {
  if (!existsSync(PROJECT)) {
    console.error(`Fixture missing at ${PROJECT}. Run: npm run fetch-libs`);
    process.exit(1);
  }

  const reg = await CemRegistry.fromProject(PROJECT);
  const names = reg.packageNames();
  if (names.length === 0) {
    console.error("No packages discovered.");
    process.exit(1);
  }

  console.log(`Bench across ${names.length} libraries\n`);

  const overall = emptyTally();
  const perLib: Array<{ name: string; tally: Tally; pkg: LoadedPackage }> = [];

  for (const name of names) {
    const pkg = await reg.get(name);
    const targets = pkg.elements.map((d) => d.tagName!);
    const cases = generateCases(pkg);
    const tally = emptyTally();

    for (const c of cases) {
      const custTags = runCustom(pkg, c.query);
      const fuzzTags = runFuzzysort(targets, c.query);
      const cr = rankOf(custTags, c.expect);
      const fr = rankOf(fuzzTags, c.expect);

      tally.total++;
      if (cr === 1) tally.cust1++;
      if (cr <= 3) tally.cust3++;
      if (fr === 1) tally.fuzz1++;
      if (fr <= 3) tally.fuzz3++;
      bumpKind(tally, c.kind, cr === 1, fr === 1);

      if (cr !== 1) {
        tally.misses.push({ kind: c.kind, query: c.query, expect: c.expect, cr, fr });
      }

      overall.total++;
      if (cr === 1) overall.cust1++;
      if (cr <= 3) overall.cust3++;
      if (fr === 1) overall.fuzz1++;
      if (fr <= 3) overall.fuzz3++;
      bumpKind(overall, c.kind, cr === 1, fr === 1);
    }

    perLib.push({ name, tally, pkg });
  }

  // Per-library summary
  console.log(pad("library", 36) + pad("comps", 7) + pad("prefix", 12) + pad("cases", 7) +
    pad("cust top1", 11) + pad("cust top3", 11) + pad("fuzz top1", 11) + "fuzz top3");
  console.log("-".repeat(102));
  for (const { name, tally, pkg } of perLib) {
    console.log(
      pad(name, 36) +
        pad(String(pkg.elements.length), 7) +
        pad(`"${pkg.prefix}"`, 12) +
        pad(String(tally.total), 7) +
        pad(pct(tally.cust1, tally.total) + ` (${tally.cust1})`, 11) +
        pad(pct(tally.cust3, tally.total) + ` (${tally.cust3})`, 11) +
        pad(pct(tally.fuzz1, tally.total) + ` (${tally.fuzz1})`, 11) +
        pct(tally.fuzz3, tally.total) + ` (${tally.fuzz3})`,
    );
  }
  console.log("-".repeat(102));
  console.log(
    pad("OVERALL", 36) +
      pad(String(perLib.reduce((a, b) => a + b.pkg.elements.length, 0)), 7) +
      pad("", 12) +
      pad(String(overall.total), 7) +
      pad(pct(overall.cust1, overall.total) + ` (${overall.cust1})`, 11) +
      pad(pct(overall.cust3, overall.total) + ` (${overall.cust3})`, 11) +
      pad(pct(overall.fuzz1, overall.total) + ` (${overall.fuzz1})`, 11) +
      pct(overall.fuzz3, overall.total) + ` (${overall.fuzz3})`,
  );

  // By query kind
  console.log("\nBy query kind (overall):");
  const kinds: CaseKind[] = ["exact", "short", "pascal", "flat", "typo-drop", "typo-ins"];
  for (const k of kinds) {
    const b = overall.byKind.get(k);
    if (!b) continue;
    console.log(
      `  ${pad(k, 12)} cases=${padN(b.total, 5)}  custom top-1=${pct(b.cust1, b.total)} (${b.cust1})  fuzzysort top-1=${pct(b.fuzz1, b.total)} (${b.fuzz1})`,
    );
  }

  // Sample misses — show up to 5 per library where custom missed top-1
  console.log("\nMisses where the custom matcher failed top-1 (up to 5 per library):");
  for (const { name, tally } of perLib) {
    const misses = tally.misses.slice(0, 5);
    if (misses.length === 0) continue;
    console.log(`\n  ${name}:`);
    for (const m of misses) {
      const note =
        m.cr === 9999 ? "not found" : m.cr <= 3 ? `rank ${m.cr}` : `rank ${m.cr} (deep)`;
      console.log(
        `    [${m.kind}] "${m.query}" → expected "${m.expect}" · custom: ${note} · fuzzysort rank ${m.fr === 9999 ? "—" : m.fr}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
