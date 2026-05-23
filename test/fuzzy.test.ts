import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIndex, fuzzySearchTags } from "../src/fuzzy.js";
import type { CemDeclaration } from "../src/cem.js";

function decls(tags: string[]): CemDeclaration[] {
  return tags.map((tag) => ({ kind: "class", name: tag, tagName: tag }));
}

describe("fuzzy: indexing", () => {
  it("detects the library-wide common prefix when it dominates", () => {
    const { prefix } = buildIndex(decls(["lib-a", "lib-b", "lib-c", "lib-d", "other-x"]));
    assert.equal(prefix, "lib");
  });

  it("returns no prefix when no token dominates", () => {
    const { prefix } = buildIndex(decls(["alpha-one", "beta-two", "gamma-three", "delta-four"]));
    assert.equal(prefix, "");
  });

  it("strips the detected prefix when building short forms", () => {
    const { index } = buildIndex(decls(["sl-button", "sl-input", "sl-input-number"]));
    const button = index.find((e) => e.tag === "sl-button")!;
    assert.deepEqual(button.shortTokens, ["button"]);
    assert.equal(button.shortPascal, "Button");
    assert.equal(button.shortFlat, "button");
  });
});

describe("fuzzy: ranking", () => {
  const sample = buildIndex(
    decls([
      "calcite-button",
      "calcite-radio-button",
      "calcite-split-button",
      "calcite-radio-button-group",
      "calcite-date-picker",
      "calcite-color-picker",
      "calcite-input-date-picker",
      "calcite-alert",
      "calcite-chip",
      "calcite-accordion",
    ]),
  );

  const top = (query: string): string | undefined =>
    fuzzySearchTags(sample.index, query, 5)[0]?.decl.tagName;

  it("ranks exact tag at #1", () => {
    assert.equal(top("calcite-button"), "calcite-button");
  });

  it("ranks the whole-word match above multi-token tags that contain the word", () => {
    assert.equal(top("button"), "calcite-button");
  });

  it("resolves PascalCase short form to the right tag", () => {
    assert.equal(top("DatePicker"), "calcite-date-picker");
    assert.equal(top("ColorPicker"), "calcite-color-picker");
  });

  it("resolves 2-char acronyms when unambiguous", () => {
    // dp is unique among the sample, so it should land at #1.
    assert.equal(top("dp"), "calcite-date-picker");
  });

  it("tolerates a single-character deletion typo", () => {
    assert.equal(top("alrt"), "calcite-alert");
    assert.equal(top("buton"), "calcite-button");
    assert.equal(top("acordion"), "calcite-accordion");
  });

  it("tolerates a single-character insertion typo", () => {
    // Regression: an earlier Damerau implementation read stale rolling-buffer
    // values and returned distance 0 for clearly different strings on inputs
    // with repeated characters, dropping these matches to score 0.
    assert.equal(top("chiip"), "calcite-chip");
    assert.equal(top("alertt"), "calcite-alert");
  });

  it("returns no hits for queries with no plausible match", () => {
    assert.equal(fuzzySearchTags(sample.index, "zzz-nothing-here").length, 0);
  });
});
