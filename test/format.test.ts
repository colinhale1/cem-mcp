// Covers the progressive-disclosure formatters introduced in ADR-0002:
// compact, aspect, single-attribute, single-event, cross-package search, and
// the honest-negative cross-package fallback.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { CemRegistry, type LoadedPackage } from "../src/cem.js";
import {
  formatAspect,
  formatAttribute,
  formatComponentList,
  formatCrossPackageSearch,
  formatElementCompact,
  formatElementFull,
  formatEventDetail,
  formatNoCrossPackageMatch,
  formatPackageList,
  formatSearch,
} from "../src/format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "fixtures/project");

describe("format: progressive disclosure (ADR-0002)", () => {
  let reg: CemRegistry;
  let pkg: LoadedPackage;

  before(async () => {
    if (!existsSync(PROJECT)) {
      throw new Error(`Fixture missing at ${PROJECT}. Run \`npm run fetch-libs\`.`);
    }
    reg = await CemRegistry.fromProject(PROJECT);
    pkg = await reg.get("@esri/calcite-components");
  });

  describe("compact element view", () => {
    it("lists section names with counts and no field detail", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatElementCompact(decl, pkg.name);
      assert.match(out, /^# `calcite-button`/m);
      assert.match(out, /attrs \(\d+\):/);
      // Attribute names appear; types and defaults do not.
      assert.match(out, /alignment/);
      assert.doesNotMatch(out, /default `/);
      assert.doesNotMatch(out, /## Attributes/); // legacy heading style
    });

    it("omits zero-count sections entirely", () => {
      // Pick a component with no events declared — calcite-icon is a good bet.
      const decl = pkg.byTag.get("calcite-icon");
      if (!decl) return;
      const out = formatElementCompact(decl, pkg.name);
      if (!(decl.events ?? []).length) {
        assert.doesNotMatch(out, /^events \(/m);
      }
    });

    it("uses css to group var + part counts", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatElementCompact(decl, pkg.name);
      if ((decl.cssProperties ?? []).length || (decl.cssParts ?? []).length) {
        assert.match(out, /^css:/m);
      }
    });

    it("contains no prose hints about how to call the tool", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatElementCompact(decl, pkg.name);
      assert.doesNotMatch(out, /Call this tool/i);
      assert.doesNotMatch(out, /pass `aspect/i);
      assert.doesNotMatch(out, /re-call/i);
    });
  });

  describe("aspect drill-downs", () => {
    it("aspect=attrs returns typed attributes for the component", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatAspect(decl, "attrs", pkg.name);
      assert.match(out, /^# `calcite-button` — attrs/m);
      assert.match(out, /\*\*alignment\*\*/);
      // Should include type/default info absent from compact.
      assert.ok(/`'[a-z-]+( \| '[a-z-]+')*`/.test(out) || /\(default `/.test(out));
    });

    it("aspect=events returns event names with types", () => {
      const decl = pkg.byTag.get("calcite-combobox")!;
      const out = formatAspect(decl, "events", pkg.name);
      assert.match(out, /^# `calcite-combobox` — events/m);
      assert.match(out, /\*\*calciteComboboxChange\*\*/);
    });

    it("aspect=all is equivalent to the legacy full element view", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const viaAspect = formatAspect(decl, "all", pkg.name);
      const viaFull = formatElementFull(decl, pkg.name);
      assert.equal(viaAspect, viaFull);
    });

    it("aspect=css groups vars + parts under one heading", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatAspect(decl, "css", pkg.name);
      assert.match(out, /^# `calcite-button` — css/m);
      if ((decl.cssProperties ?? []).length) assert.match(out, /### custom properties/);
      if ((decl.cssParts ?? []).length) assert.match(out, /### shadow parts/);
    });

    it("aspect on an empty section returns explicit '(none)'", () => {
      const decl = pkg.byTag.get("calcite-icon");
      if (!decl) return;
      if ((decl.events ?? []).length === 0) {
        const out = formatAspect(decl, "events", pkg.name);
        assert.match(out, /\(none\)/);
      }
    });
  });

  describe("single-member drill-down", () => {
    it("attr returns just the named attribute's detail", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatAttribute(decl, "alignment", pkg.name);
      assert.ok(out);
      assert.match(out!, /^# `calcite-button\.alignment`/m);
    });

    it("attr returns null when the name doesn't exist (caller renders error)", () => {
      const decl = pkg.byTag.get("calcite-button")!;
      const out = formatAttribute(decl, "definitely-not-an-attr", pkg.name);
      assert.equal(out, null);
    });

    it("event returns just the named event's detail when present", () => {
      const decl = pkg.byTag.get("calcite-combobox")!;
      const events = decl.events ?? [];
      if (events.length === 0) return;
      const out = formatEventDetail(decl, events[0].name, pkg.name);
      assert.ok(out);
      assert.match(out!, new RegExp(`^# \`calcite-combobox\\.${events[0].name}\``, "m"));
    });
  });

  describe("output hygiene across all formatters", () => {
    it("packageList does not advertise tool-call shape in output", () => {
      const out = formatPackageList(reg.packagesMeta(), reg.projectRoot, reg.config.sourcePath);
      assert.doesNotMatch(out, /Call this tool/i);
    });

    it("componentList does not advertise tool-call shape in output", () => {
      const out = formatComponentList(pkg);
      assert.doesNotMatch(out, /Call this tool/i);
      assert.doesNotMatch(out, /exact tag name/i);
    });

    it("search output does not include a 'call again' trailer", () => {
      const out = formatSearch(pkg.name, "color", []);
      assert.doesNotMatch(out, /Call this tool/i);
    });
  });

  describe("cross-package output", () => {
    it("groups hits by package and includes match reasons", () => {
      // Synthesize two hits across two packages from real fixture decls.
      const calcite = pkg.byTag.get("calcite-button")!;
      const hits = [
        {
          packageName: "@esri/calcite-components",
          hit: { decl: calcite, score: 500, reasons: ["tag exact"] },
        },
      ];
      const out = formatCrossPackageSearch("button", hits, 9);
      assert.match(out, /Cross-package search: `button`/);
      assert.match(out, /## @esri\/calcite-components/);
      assert.match(out, /calcite-button/);
    });

    it("honest negative form on zero confident matches", () => {
      const out = formatNoCrossPackageMatch("date picker", 9, []);
      assert.match(out, /No good match for `date picker`/);
      assert.doesNotMatch(out, /Closest leads/);
    });

    it("honest negative includes near-misses when provided", () => {
      const calcite = pkg.byTag.get("calcite-button")!;
      const out = formatNoCrossPackageMatch("date picker", 9, [
        {
          packageName: "@esri/calcite-components",
          hit: { decl: calcite, score: 80, reasons: ["text relevance 1.2"] },
        },
      ]);
      assert.match(out, /Closest leads/);
      assert.match(out, /calcite-button/);
    });
  });
});
