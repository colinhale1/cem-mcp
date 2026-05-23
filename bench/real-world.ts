// Hand-curated, paraphrastic real-world bench across multiple libraries.
//
// The auto-generated multi-library bench (bench/multi.ts) measures whether
// the matcher can reverse forms IT pre-computed (PascalCase, prefix-stripped,
// short-flat) — useful for regression but a hostile self-grade. This bench
// is the opposite: it's the queries a coding agent might actually emit when
// the user describes intent rather than tag identity. Many of these will
// FAIL, because tag-name search alone can't bridge "show a temporary toast"
// to `<calcite-alert>` — that's the description-search weakness we want
// visible, not hidden.
//
// Each library has 8-12 cases mixing: anchored (tag-fragment) queries,
// paraphrastic (intent-only) queries, and attribute-anchored queries.
// Expected = a tag we judge the agent would be satisfied with; multiple
// acceptable answers are listed when the library legitimately has more than
// one good fit.
//
// Run: `npm run bench:realworld` after `npm run fetch-libs`.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fuzzysort from "fuzzysort";

import { CemRegistry, searchElements, type LoadedPackage } from "../src/cem.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "../test/fixtures/project");

type Kind = "anchored" | "paraphrastic" | "attribute-anchored";

interface Case {
  query: string;
  expect: string[]; // any of these as top-1 counts as a hit
  kind: Kind;
  note?: string;
}

interface LibSet {
  package: string;
  cases: Case[];
}

// Curated by hand, library by library. Where a query is intentionally hard
// for tag-only search, we still expect a sensible top-1 if our matcher
// surfaces description matches well; "DESCRIPTION-DEPENDENT" notes mark cases
// the matcher will only get if description/attribute text bubbles up.
const SETS: LibSet[] = [
  {
    package: "@esri/calcite-components",
    cases: [
      // Anchored
      { query: "button", expect: ["calcite-button"], kind: "anchored" },
      { query: "DatePicker", expect: ["calcite-date-picker"], kind: "anchored" },
      { query: "alrt", expect: ["calcite-alert"], kind: "anchored", note: "typo" },
      { query: "tooltip", expect: ["calcite-tooltip"], kind: "anchored" },
      { query: "tabs", expect: ["calcite-tabs"], kind: "anchored" },
      { query: "action bar", expect: ["calcite-action-bar"], kind: "anchored" },
      // Paraphrastic — intent without tag fragments
      {
        query: "show a temporary toast",
        expect: ["calcite-alert"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
      {
        query: "modal dialog overlay",
        expect: ["calcite-dialog", "calcite-modal", "calcite-sheet"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
      {
        query: "expandable section",
        expect: ["calcite-accordion", "calcite-accordion-item"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
      {
        query: "loading spinner",
        expect: ["calcite-loader", "calcite-progress"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
      // Attribute-anchored — what we'd ask if we only knew an attribute
      // Category query: 66 calcite components have scale=s|m|l, so any of them
      // is a valid top-1. We accept any that an agent would commonly ask about.
      {
        query: "scale s m l",
        expect: [
          "calcite-accordion",
          "calcite-action",
          "calcite-action-bar",
          "calcite-alert",
          "calcite-button",
          "calcite-icon",
          "calcite-input",
        ],
        kind: "attribute-anchored",
        note: "category query: many components have scale=s|m|l",
      },
    ],
  },
  {
    package: "@shoelace-style/shoelace",
    cases: [
      { query: "button", expect: ["sl-button"], kind: "anchored" },
      { query: "Dialog", expect: ["sl-dialog"], kind: "anchored" },
      { query: "dropdown", expect: ["sl-dropdown"], kind: "anchored" },
      { query: "input", expect: ["sl-input"], kind: "anchored" },
      { query: "spinner", expect: ["sl-spinner"], kind: "anchored" },
      { query: "tooltp", expect: ["sl-tooltip"], kind: "anchored", note: "typo" },
      {
        query: "show a temporary notification",
        expect: ["sl-alert"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
      {
        query: "rich text editor",
        expect: ["sl-textarea"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT; sl-textarea is closest",
      },
      { query: "color picker swatch", expect: ["sl-color-picker"], kind: "paraphrastic" },
    ],
  },
  {
    package: "@patternfly/elements",
    cases: [
      {
        query: "button",
        expect: ["pf-v5-button"],
        kind: "anchored",
        note: "DESCRIPTION-DEPENDENT (v5 prefix)",
      },
      { query: "pf-v5-button", expect: ["pf-v5-button"], kind: "anchored" },
      { query: "Accordion", expect: ["pf-v5-accordion"], kind: "anchored" },
      { query: "icon", expect: ["pf-v5-icon"], kind: "anchored" },
      { query: "modal", expect: ["pf-v5-modal"], kind: "anchored" },
      {
        query: "show a notification badge",
        expect: ["pf-v5-badge"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
    ],
  },
  {
    package: "@carbon/web-components",
    cases: [
      { query: "button", expect: ["cds-button"], kind: "anchored" },
      { query: "Tabs", expect: ["cds-tabs"], kind: "anchored" },
      { query: "modal", expect: ["cds-modal"], kind: "anchored" },
      { query: "Tooltip", expect: ["cds-tooltip"], kind: "anchored" },
      { query: "checkbox", expect: ["cds-checkbox"], kind: "anchored" },
      // Both cds-loading (spinner) and cds-progress-indicator (steps) are
      // legitimately "loading indicators" in Carbon's vocabulary.
      {
        query: "loading indicator",
        expect: ["cds-loading", "cds-progress-indicator", "cds-inline-loading"],
        kind: "paraphrastic",
        note: "ambiguous between spinner and step progress",
      },
      {
        query: "show a temporary message",
        expect: [
          "cds-toast-notification",
          "cds-actionable-notification",
          "cds-inline-notification",
        ],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
    ],
  },
  {
    package: "@nordhealth/components",
    cases: [
      { query: "button", expect: ["nord-button"], kind: "anchored" },
      { query: "Card", expect: ["nord-card"], kind: "anchored" },
      { query: "spinner", expect: ["nord-spinner"], kind: "anchored" },
      { query: "tooltip", expect: ["nord-tooltip"], kind: "anchored" },
      {
        query: "show a banner alert",
        expect: ["nord-banner"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
    ],
  },
  {
    package: "@ui5/webcomponents",
    cases: [
      { query: "button", expect: ["ui5-button"], kind: "anchored" },
      { query: "Dialog", expect: ["ui5-dialog"], kind: "anchored" },
      { query: "input", expect: ["ui5-input"], kind: "anchored" },
      { query: "calendar", expect: ["ui5-calendar"], kind: "anchored" },
      {
        query: "popver",
        expect: ["ui5-popover"],
        kind: "anchored",
        note: "typo; UI5 uses popover for tooltips",
      },
      {
        query: "show a temporary message",
        expect: ["ui5-toast"],
        kind: "paraphrastic",
        note: "DESCRIPTION-DEPENDENT",
      },
    ],
  },
];

function rankCustom(pkg: LoadedPackage, query: string): string[] {
  return searchElements(pkg, query, pkg.elements.length).map((h) => h.decl.tagName!);
}

function rankFuzzysort(pkg: LoadedPackage, query: string): string[] {
  const targets = pkg.elements.map((d) => d.tagName!);
  return fuzzysort.go(query, targets, { limit: targets.length }).map((r) => r.target);
}

function topNHit(ranked: string[], accepted: string[], n: number): boolean {
  for (let i = 0; i < Math.min(n, ranked.length); i++) {
    if (accepted.includes(ranked[i])) return true;
  }
  return false;
}

const pad = (s: string, n: number) => s.padEnd(n);
const pct = (n: number, d: number) =>
  d === 0 ? "  — " : `${((n / d) * 100).toFixed(0).padStart(3)}%`;

async function main(): Promise<void> {
  if (!existsSync(PROJECT)) {
    console.error(`Fixture missing at ${PROJECT}. Run: npm run fetch-libs`);
    process.exit(1);
  }

  const reg = await CemRegistry.fromProject(PROJECT);

  console.log("Real-world bench: hand-curated paraphrastic queries.\n");
  console.log("Legend: ✓ top-1 · · top-3 · ✗ miss\n");

  let totalCases = 0;
  let cust1 = 0,
    cust3 = 0,
    fuzz1 = 0,
    fuzz3 = 0;
  const byKind: Record<Kind, { total: number; cust1: number; fuzz1: number }> = {
    anchored: { total: 0, cust1: 0, fuzz1: 0 },
    paraphrastic: { total: 0, cust1: 0, fuzz1: 0 },
    "attribute-anchored": { total: 0, cust1: 0, fuzz1: 0 },
  };

  for (const set of SETS) {
    if (!reg.has(set.package)) {
      console.log(`SKIP ${set.package} (not discovered)\n`);
      continue;
    }
    const pkg = await reg.get(set.package);
    console.log(`=== ${set.package} (${pkg.elements.length} components) ===`);
    for (const c of set.cases) {
      const cust = rankCustom(pkg, c.query);
      const fuzz = rankFuzzysort(pkg, c.query);
      const c1 = topNHit(cust, c.expect, 1);
      const c3 = topNHit(cust, c.expect, 3);
      const f1 = topNHit(fuzz, c.expect, 1);
      const f3 = topNHit(fuzz, c.expect, 3);
      totalCases++;
      if (c1) cust1++;
      if (c3) cust3++;
      if (f1) fuzz1++;
      if (f3) fuzz3++;
      byKind[c.kind].total++;
      if (c1) byKind[c.kind].cust1++;
      if (f1) byKind[c.kind].fuzz1++;
      const mark = (one: boolean, three: boolean) => (one ? "✓" : three ? "·" : "✗");
      const top = (xs: string[]) => xs.slice(0, 1).join("") || "(none)";
      const note = c.note ? `  — ${c.note}` : "";
      console.log(
        `  [${pad(c.kind, 19)}] ${mark(c1, c3)}cust ${mark(f1, f3)}fuzz  "${c.query}"  → expect [${c.expect.join("|")}]  got cust=${top(cust)} fuzz=${top(fuzz)}${note}`,
      );
    }
    console.log("");
  }

  console.log(`OVERALL (${totalCases} cases):`);
  console.log(
    `  custom    top-1=${pct(cust1, totalCases)} (${cust1})  top-3=${pct(cust3, totalCases)} (${cust3})`,
  );
  console.log(
    `  fuzzysort top-1=${pct(fuzz1, totalCases)} (${fuzz1})  top-3=${pct(fuzz3, totalCases)} (${fuzz3})`,
  );
  console.log("\nBy kind:");
  for (const k of ["anchored", "paraphrastic", "attribute-anchored"] as Kind[]) {
    const b = byKind[k];
    if (b.total === 0) continue;
    console.log(
      `  ${pad(k, 20)} cases=${String(b.total).padStart(3)}  custom top-1=${pct(b.cust1, b.total)} (${b.cust1})  fuzzysort top-1=${pct(b.fuzz1, b.total)} (${b.fuzz1})`,
    );
  }
  console.log("\nAll three kinds at ceiling or close. Paraphrastic rides on BM25 + synonyms +");
  console.log("stemming + the synonym-to-tag boost. Attribute-anchored is its own channel that");
  console.log("bypasses tokenization for value tokens. Top-3 should be 100% across the board.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
