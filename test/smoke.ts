// Smoke test for the package-aware CEM tool. Exercises the same dispatch
// the MCP server uses against the Calcite 5 fixture laid out as a real
// project under test/fixtures/project. Run via `npm run smoke`.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { CemRegistry, searchElements } from "../src/cem.js";
import {
  formatComponentList,
  formatElement,
  formatMulti,
  formatPackageList,
  formatSearch,
} from "../src/format.js";
import { fuzzySearchTags } from "../src/fuzzy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "fixtures/project");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
}

async function main() {
  if (!existsSync(PROJECT)) {
    console.error(`Fixture missing: ${PROJECT}\nRun: npm run fetch-calcite`);
    process.exit(1);
  }

  // Discovery
  const reg = await CemRegistry.fromProject(PROJECT);
  assert(reg.has("@esri/calcite-components"), "discovery finds @esri/calcite-components");
  assert(reg.packageNames().length >= 1, "registry has at least one package");

  const listed = formatPackageList(reg.packagesMeta(), reg.projectRoot);
  assert(listed.includes("@esri/calcite-components"), "package list includes calcite");

  // Lazy load
  const pkg = await reg.get("@esri/calcite-components");
  assert(pkg.elements.length > 50, `loaded ${pkg.elements.length} components from calcite`);
  assert(pkg.byTag.has("calcite-button"), "byTag includes calcite-button");
  assert(pkg.prefix === "calcite", `detected common prefix '${pkg.prefix}' (expected 'calcite')`);

  // Component list
  const all = formatComponentList(pkg);
  assert(all.includes("calcite-button"), "component list includes calcite-button");
  assert(all.startsWith("# `@esri/calcite-components"), "component list header names the package");

  // Full element doc
  const btn = pkg.byTag.get("calcite-button")!;
  const btnDoc = formatElement(btn, pkg.name);
  assert(btnDoc.includes("@esri/calcite-components"), "element doc labels the package");
  assert(btnDoc.includes("## Attributes"), "element doc has Attributes section");
  assert(btnDoc.includes("alignment"), "element doc includes 'alignment' attribute");

  // Fuzzy index: PascalCase, acronym, typo
  const ranks = (q: string): string[] =>
    fuzzySearchTags(pkg.index, q, pkg.elements.length).map((h) => h.decl.tagName!);
  assert(ranks("DatePicker")[0] === "calcite-date-picker", "fuzzy: DatePicker → calcite-date-picker top-1");
  assert(ranks("dp")[0] === "calcite-date-picker", "fuzzy: acronym dp → calcite-date-picker top-1");
  assert(ranks("alrt")[0] === "calcite-alert", "fuzzy: typo alrt → calcite-alert top-1");
  assert(ranks("chiip")[0] === "calcite-chip", "fuzzy: insertion typo chiip → calcite-chip top-1");

  // Combined search (tag + description/attributes substring)
  const hits = searchElements(pkg, "accordion");
  assert(hits.length >= 2, `search 'accordion' returns multiple hits (got ${hits.length})`);
  assert(hits[0].decl.tagName === "calcite-accordion", "search 'accordion' top hit is calcite-accordion");
  const empty = searchElements(pkg, "zzz-nope-nothing");
  assert(empty.length === 0, "search for nonsense term returns no hits");

  // Search formatter
  const search = formatSearch(pkg.name, "accordion", hits);
  assert(search.startsWith("# Search `@esri/calcite-components`:"), "search header names the package");

  // Multi-query — mirror the server's promote-to-full-docs heuristic.
  const isDefinitive = (hs: { score: number }[]): boolean =>
    hs.length === 1 || (hs.length > 1 && hs[0].score >= 400 && hs[0].score >= 2 * hs[1].score);
  const dispatch = (q: string): string => {
    if (!q || q.toLowerCase() === "all") return formatComponentList(pkg);
    const e = pkg.byTag.get(q.toLowerCase());
    if (e) return formatElement(e, pkg.name);
    const h = searchElements(pkg, q);
    return isDefinitive(h) ? formatElement(h[0].decl, pkg.name) : formatSearch(pkg.name, q, h);
  };
  const multi = formatMulti(pkg.name, [
    { query: "calcite-button", body: dispatch("calcite-button") },
    { query: "calcite-alert", body: dispatch("calcite-alert") },
    { query: "DatePicker", body: dispatch("DatePicker") },
  ]);
  assert(multi.startsWith("# Multi-query: `@esri/calcite-components` (3)"), "multi header names the package");
  assert((multi.match(/^---$/gm) ?? []).length === 2, "multi uses 2 separators between 3 sections");
  assert(multi.includes("# `calcite-button`"), "multi embeds full calcite-button docs");
  assert(multi.includes("# `calcite-date-picker`"), "multi resolves 'DatePicker' to calcite-date-picker via fuzzy");

  // Unknown package surfaces a usable error path
  try {
    await reg.get("@nonexistent/library");
    assert(false, "unknown package should throw");
  } catch (e) {
    assert(
      String(e).includes("Unknown package") && String(e).includes("Available"),
      "unknown package error names available packages",
    );
  }

  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
