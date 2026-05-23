// Tests for the snippet validator introduced in ADR-0002. Covers HTML tag
// recognition, attribute existence checks, enum-value checks, and the
// edge-case attribute prefixes (data-*, aria-*, on*, :, @, ., ?).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { CemRegistry } from "../src/cem.js";
import { extractEnumValues, formatValidationResult, validateSnippet } from "../src/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "fixtures/project");

describe("validate: snippet checks", () => {
  let reg: CemRegistry;

  before(async () => {
    if (!existsSync(PROJECT)) {
      throw new Error(`Fixture missing at ${PROJECT}. Run \`npm run fetch-libs\`.`);
    }
    reg = await CemRegistry.fromProject(PROJECT);
  });

  describe("extractEnumValues", () => {
    it("returns the literal members of a string-union type", () => {
      assert.deepEqual(extractEnumValues("'small' | 'medium' | 'large'"), [
        "small",
        "medium",
        "large",
      ]);
    });

    it("handles single-quoted, double-quoted, and tight pipes", () => {
      assert.deepEqual(extractEnumValues('"s"|"m"|"l"'), ["s", "m", "l"]);
    });

    it("returns null for non-union types", () => {
      assert.equal(extractEnumValues("string"), null);
      assert.equal(extractEnumValues("boolean"), null);
      assert.equal(extractEnumValues("number | string"), null); // not a string-literal union
      assert.equal(extractEnumValues(undefined), null);
    });
  });

  describe("validateSnippet against the calcite fixture", () => {
    it("accepts a clean usage", async () => {
      const snippet = `<calcite-button kind="brand" scale="m">Save</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      assert.equal(r.tagsFound, 1);
      assert.equal(r.tagsValidated, 1);
      assert.deepEqual(r.issues, []);
    });

    it("flags an unknown custom element with a did-you-mean", async () => {
      const snippet = `<calcite-buttn>oops</calcite-buttn>`;
      const r = await validateSnippet(reg, snippet);
      assert.equal(r.tagsFound, 1);
      assert.equal(r.tagsValidated, 0);
      assert.equal(r.issues.length, 1);
      assert.equal(r.issues[0].kind, "unknown-tag");
      assert.match(r.issues[0].message, /Unknown custom element/);
      assert.ok(r.issues[0].suggestion?.includes("calcite-button"));
    });

    it("flags an unknown attribute and suggests the nearest known one", async () => {
      const snippet = `<calcite-button alignmnt="center">hi</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      assert.equal(r.tagsValidated, 1);
      assert.equal(r.issues.length, 1);
      assert.equal(r.issues[0].kind, "unknown-attr");
      assert.match(r.issues[0].message, /Unknown attribute `alignmnt`/);
      assert.ok(r.issues[0].suggestion?.includes("alignment"));
    });

    it("flags an enum-typed attribute value outside the union", async () => {
      // calcite-button's kind is "brand" | "danger" | "inverse" | "neutral".
      // Use a 1-edit typo so the did-you-mean falls within the suggestion cap.
      const snippet = `<calcite-button kind="dangr">x</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      const issue = r.issues.find((i) => i.kind === "invalid-value");
      assert.ok(issue, "expected invalid-value issue");
      assert.match(issue!.message, /Invalid value `dangr`/);
      assert.ok(issue!.suggestion?.includes("danger"));
    });

    it("flags a value with no near suggestion when nothing is within edit-distance", async () => {
      const snippet = `<calcite-button kind="totallyBogus">x</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      const issue = r.issues.find((i) => i.kind === "invalid-value");
      assert.ok(issue);
      assert.equal(issue!.suggestion, undefined);
    });

    it("ignores standard HTML, data-*, aria-*, on* attributes", async () => {
      const snippet = `<calcite-button id="x" class="y" data-foo="z" aria-label="ok" onclick="f()">k</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      assert.deepEqual(r.issues, []);
    });

    it("ignores Lit/Vue binding prefixes for enum-value checks but still validates the attr name", async () => {
      // :variant binds dynamically — we can't evaluate the expression, so skip
      // value validation, but still confirm the attribute is real.
      const okSnippet = `<calcite-button :kind="someVar">x</calcite-button>`;
      const okR = await validateSnippet(reg, okSnippet);
      assert.equal(okR.issues.length, 0);

      const badSnippet = `<calcite-button :nonsense="x">y</calcite-button>`;
      const badR = await validateSnippet(reg, badSnippet);
      assert.equal(badR.issues.length, 1);
      assert.equal(badR.issues[0].kind, "unknown-attr");
    });

    it("does not flag standard HTML tags (no hyphen)", async () => {
      const snippet = `<div class="x"><span>hi</span></div>`;
      const r = await validateSnippet(reg, snippet);
      assert.equal(r.tagsFound, 0);
      assert.equal(r.issues.length, 0);
    });

    it("skips content inside HTML comments", async () => {
      const snippet = `<!-- <calcite-fake>not real</calcite-fake> --><calcite-button>real</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      assert.equal(r.tagsFound, 1);
      assert.equal(r.issues.length, 0);
    });

    it("scopes validation to one package when `package` is passed", async () => {
      // sl-button exists in shoelace but not in calcite — scoping to calcite
      // should flag it as unknown.
      const snippet = `<sl-button>hello</sl-button>`;
      const r = await validateSnippet(reg, snippet, { package: "@esri/calcite-components" });
      assert.equal(r.issues.length, 1);
      assert.equal(r.issues[0].kind, "unknown-tag");
    });

    it("reports line and column for each issue", async () => {
      const snippet = `<calcite-button>ok</calcite-button>\n<calcite-fake>bad</calcite-fake>`;
      const r = await validateSnippet(reg, snippet);
      const fake = r.issues.find((i) => i.tag === "calcite-fake");
      assert.ok(fake);
      assert.equal(fake!.line, 2);
      assert.equal(fake!.column, 1);
    });
  });

  describe("formatValidationResult", () => {
    it("returns ok when there are no issues", async () => {
      const snippet = `<calcite-button>x</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      const out = formatValidationResult(r);
      assert.match(out, /^# Validation: ok/m);
    });

    it("includes line/col and a numbered list when issues exist", async () => {
      const snippet = `<calcite-button alignmnt="x">y</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      const out = formatValidationResult(r);
      assert.match(out, /# Validation: 1 issue/);
      assert.match(out, /\[unknown-attr\]/);
      assert.match(out, /\(line 1, col 1\)/);
    });
  });
});
