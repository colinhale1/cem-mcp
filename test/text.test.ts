import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stem, tokenize } from "../src/text.js";

describe("stem", () => {
  it("strips -able and -ible from long-enough words", () => {
    assert.equal(stem("expandable"), "expand");
    assert.equal(stem("collapsible"), "collaps");
  });

  it("strips -ing, -ed, -ly", () => {
    assert.equal(stem("loading"), "load");
    assert.equal(stem("loaded"), "load");
    assert.equal(stem("quickly"), "quick");
  });

  it("strips plural -s only when long enough and not -ss / -us", () => {
    assert.equal(stem("buttons"), "button");
    assert.equal(stem("alias"), "alias"); // 5 chars, would over-stem
    assert.equal(stem("status"), "status"); // -us, preserved
    assert.equal(stem("classes"), "classe"); // -es is fine, -ss not stripped
  });

  it("leaves short words alone", () => {
    assert.equal(stem("tab"), "tab");
    assert.equal(stem("this"), "this");
    assert.equal(stem("was"), "was");
  });

  it("does not over-stem common UI nouns", () => {
    // notification once tripped an over-aggressive -ation rule.
    assert.equal(stem("notification"), "notification");
    assert.equal(stem("indicator"), "indicator");
    assert.equal(stem("accordion"), "accordion");
  });
});

describe("tokenize", () => {
  it("lowercases, drops short tokens, drops stopwords", () => {
    assert.deepEqual(
      tokenize("Shows a temporary toast notification to the user"),
      ["temporary", "toast", "notification", "user"],
    );
  });

  it("splits camelCase and PascalCase boundaries", () => {
    // "on" is dropped as a stopword after the camelCase split.
    assert.deepEqual(tokenize("onValueChange DatePicker"), [
      "value",
      "change",
      "date",
      "picker",
    ]);
  });

  it("splits on punctuation, dashes, underscores, and HTML brackets", () => {
    assert.deepEqual(tokenize("<sl-button> and `color-scheme` here"), [
      "sl",
      "button",
      "color",
      "scheme",
    ]);
  });

  it("keeps UI-meaningful short words like 'tab' but drops generic stopwords", () => {
    const out = tokenize("tab panel and the menu");
    assert.ok(out.includes("tab"));
    assert.ok(out.includes("panel"));
    assert.ok(out.includes("menu"));
    assert.ok(!out.includes("and"));
    assert.ok(!out.includes("the"));
  });

  it("drops vague UI verbs ('show', 'display') so they don't dominate scoring", () => {
    const out = tokenize("Shows and displays a notification banner");
    assert.ok(!out.includes("shows"));
    assert.ok(!out.includes("displays"));
    assert.ok(out.includes("notification"));
    assert.ok(out.includes("banner"));
  });

  it("returns an empty array for empty / null input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
  });
});
