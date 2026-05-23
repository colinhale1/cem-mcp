// Smoke test: drive the same query dispatch the MCP tool uses, against
// the Calcite 5 CEM fixture. Run via `npm run smoke`.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { loadCem, searchElements } from "../src/cem.js";
import { formatElement, formatList, formatSearch } from "../src/format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/calcite.custom-elements.json");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
}

async function main() {
  if (!existsSync(FIXTURE)) {
    console.error(`Fixture missing: ${FIXTURE}\nRun: npm run fetch-calcite`);
    process.exit(1);
  }
  const cem = await loadCem(FIXTURE);
  assert(cem.elements.length > 50, `loaded > 50 elements (got ${cem.elements.length})`);
  assert(cem.byTag.has("calcite-button"), "byTag includes calcite-button");

  const all = formatList(cem);
  assert(all.includes("calcite-button"), "formatList includes calcite-button");
  assert(all.startsWith("# Components"), "formatList starts with heading");

  const btn = cem.byTag.get("calcite-button");
  assert(btn, "calcite-button declaration present");
  const btnDoc = formatElement(btn!);
  assert(btnDoc.includes("## Attributes"), "calcite-button doc has Attributes section");
  assert(btnDoc.includes("alignment"), "calcite-button doc includes 'alignment' attribute");
  assert(btnDoc.includes("## Slots"), "calcite-button doc has Slots section");
  assert(btnDoc.includes("## CSS Custom Properties"), "calcite-button doc has CSS vars section");

  const hits = searchElements(cem, "accordion");
  assert(hits.length >= 2, `search 'accordion' returns multiple hits (got ${hits.length})`);
  const tags = hits.map((h) => h.decl.tagName);
  assert(tags.includes("calcite-accordion"), "search 'accordion' includes calcite-accordion");
  const search = formatSearch("accordion", hits);
  assert(search.startsWith("# Search:"), "formatSearch starts with heading");

  const empty = searchElements(cem, "zzz-nope-nothing");
  assert(empty.length === 0, "search for non-existent term returns no hits");

  // Exercise the dispatch shape the MCP tool uses.
  const exactQuery = "CALCITE-BUTTON"; // case-insensitive
  const exact = cem.byTag.get(exactQuery.toLowerCase());
  assert(exact, "exact lookup is case-insensitive");

  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
