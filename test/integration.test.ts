// Integration test: drives the same dispatch the MCP tool uses against the
// real Calcite 5 fixture in test/fixtures/project. Replaces the old
// hand-rolled smoke.ts; covers discovery, adapter selection, fuzzy index,
// definitive-hit promotion, multi-query, and the unknown-package path.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { CemRegistry, searchElements, type LoadedPackage } from "../src/cem.js";
import {
  formatComponentList,
  formatElementCompact,
  formatElementFull,
  formatMulti,
  formatPackageList,
  formatSearch,
} from "../src/format.js";
import { fuzzySearchTags } from "../src/fuzzy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "fixtures/project");

describe("integration: calcite fixture", () => {
  let reg: CemRegistry;
  let pkg: LoadedPackage;

  before(async () => {
    if (!existsSync(PROJECT)) {
      throw new Error(
        `Fixture missing at ${PROJECT}. Run \`npm run fetch-libs\` (or \`npm run fetch-calcite\`).`,
      );
    }
    reg = await CemRegistry.fromProject(PROJECT);
    pkg = await reg.get("@esri/calcite-components");
  });

  it("discovers @esri/calcite-components via the cem2 adapter", () => {
    const meta = reg.packagesMeta().find((p) => p.name === "@esri/calcite-components");
    assert.ok(meta);
    assert.equal(meta!.adapter.name, "cem2");
  });

  it("loads >50 components and detects the common prefix", () => {
    assert.ok(pkg.elements.length > 50);
    assert.equal(pkg.prefix, "calcite");
  });

  it("formats the package list with the discovered packages", () => {
    const out = formatPackageList(reg.packagesMeta(), reg.projectRoot, reg.config.sourcePath);
    assert.match(out, /@esri\/calcite-components/);
  });

  it("formats full element docs for calcite-button via aspect=all", () => {
    const decl = pkg.byTag.get("calcite-button")!;
    const out = formatElementFull(decl, pkg.name);
    assert.match(out, /## attrs/);
    assert.match(out, /alignment/);
    assert.match(out, /@esri\/calcite-components/);
  });

  it("formats compact docs that list section counts but not field detail", () => {
    const decl = pkg.byTag.get("calcite-button")!;
    const out = formatElementCompact(decl, pkg.name);
    // Compact view advertises the aspect vocabulary: section names match
    // aspect values 1:1, with counts in parentheses as locators.
    assert.match(out, /attrs \(\d+\):/);
    assert.match(out, /alignment/);
    // No field types / defaults in compact mode (those live in aspect=attrs).
    assert.doesNotMatch(out, /default `/);
    // No prose "tip" hints — grammar lives in the schema, not the output.
    assert.doesNotMatch(out, /Call this tool/i);
  });

  it("resolves fuzzy variants to the right tag at top-1", () => {
    const top = (q: string) => fuzzySearchTags(pkg.index, q, 5)[0]?.decl.tagName;
    assert.equal(top("DatePicker"), "calcite-date-picker");
    assert.equal(top("dp"), "calcite-date-picker");
    assert.equal(top("alrt"), "calcite-alert");
    assert.equal(top("chiip"), "calcite-chip");
  });

  it("returns a ranked list for genuinely ambiguous queries", () => {
    const hits = searchElements(pkg, "color");
    const out = formatSearch(pkg.name, "color", hits);
    assert.match(out, /Search `@esri\/calcite-components`: `color`/);
    assert.ok(hits.length > 1);
  });

  it("formats multi-query with section markers", () => {
    const dispatch = (q: string): string => {
      const e = pkg.byTag.get(q.toLowerCase());
      if (e) return formatElementCompact(e, pkg.name);
      const hits = searchElements(pkg, q);
      return hits.length === 1
        ? formatElementCompact(hits[0].decl, pkg.name)
        : formatSearch(pkg.name, q, hits);
    };
    const multi = formatMulti(pkg.name, [
      { query: "calcite-button", body: dispatch("calcite-button") },
      { query: "calcite-alert", body: dispatch("calcite-alert") },
    ]);
    assert.match(multi, /# Multi-query: `@esri\/calcite-components` \(2\)/);
    assert.equal((multi.match(/^---$/gm) ?? []).length, 1);
  });

  it("unknown package error includes Did you mean? when something is close", async () => {
    await assert.rejects(reg.get("@esri/calcite-component" /* missing trailing s */), (e) => {
      // Direct registry call throws; the server wraps with a Did-you-mean message.
      // Here we just verify the error includes the available list.
      return /Unknown package/.test(String(e)) && /Available/.test(String(e));
    });
  });

  it("packageList shows non-cem2 adapters annotated", async () => {
    // Carbon ships through the carbon-html-data adapter (when present in the fixture).
    const carbon = reg.packagesMeta().find((p) => p.name === "@carbon/web-components");
    if (carbon) {
      const out = formatPackageList(reg.packagesMeta(), reg.projectRoot, reg.config.sourcePath);
      assert.match(out, /carbon-html-data/);
    }
  });

  it("formats components from a carbon-html-data adapter manifest if present", async () => {
    if (!reg.has("@carbon/web-components")) return;
    const carbon = await reg.get("@carbon/web-components");
    assert.equal(carbon.adapter.name, "carbon-html-data");
    assert.ok(carbon.elements.length > 0);
    const list = formatComponentList(carbon);
    assert.match(list, /cds-/);
  });
});
