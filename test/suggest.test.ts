import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { suggestPackages } from "../src/suggest.js";

describe("suggestPackages", () => {
  const available = [
    "@esri/calcite-components",
    "@shoelace-style/shoelace",
    "@patternfly/elements",
    "@rhds/elements",
    "@nordhealth/components",
    "@carbon/web-components",
    "@cds/core",
    "@ui5/webcomponents",
  ];

  it("returns the exact match when query matches a package name modulo punctuation", () => {
    const got = suggestPackages("esri/calcite-components", available, 3);
    assert.equal(got[0], "@esri/calcite-components");
  });

  it("matches substrings (no scope prefix)", () => {
    const got = suggestPackages("shoelace", available, 3);
    assert.equal(got[0], "@shoelace-style/shoelace");
  });

  it("tolerates a single typo", () => {
    const got = suggestPackages("calcit-components", available, 3);
    assert.equal(got[0], "@esri/calcite-components");
  });

  it("returns nothing for an unrelated query", () => {
    assert.deepEqual(suggestPackages("totally-unrelated-zzz", available, 3), []);
  });

  it("respects the limit", () => {
    const got = suggestPackages("components", available, 2);
    assert.equal(got.length <= 2, true);
  });
});
