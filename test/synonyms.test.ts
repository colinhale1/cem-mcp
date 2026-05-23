import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSynonymMap, expandQuery } from "../src/synonyms.js";

describe("synonyms", () => {
  it("built-in map is bidirectional: toast ↔ alert", () => {
    const m = buildSynonymMap();
    assert.ok(m.get("toast")?.includes("alert"));
    assert.ok(m.get("alert")?.includes("toast"));
  });

  it("does not include the key itself in its own synonyms", () => {
    const m = buildSynonymMap();
    assert.ok(!m.get("toast")?.includes("toast"));
  });

  it("config.extend adds new pairs bidirectionally", () => {
    const m = buildSynonymMap(undefined, { snackbar: ["chip"] });
    assert.ok(m.get("snackbar")?.includes("chip"));
    assert.ok(m.get("chip")?.includes("snackbar"));
  });

  it("disable=true drops the built-in map entirely", () => {
    const m = buildSynonymMap(undefined, {}, true);
    assert.equal(m.size, 0);
  });

  it("disable=true with extend only uses the extensions", () => {
    const m = buildSynonymMap(undefined, { onlyterm: ["alias"] }, true);
    assert.deepEqual(Array.from(m.keys()).sort(), ["alias", "onlyterm"]);
  });

  it("expandQuery emits original tokens at weight 1 and synonyms at lower weight", () => {
    const m = buildSynonymMap();
    const out = expandQuery(["toast"], m, 0.6);
    const toast = out.find((w) => w.term === "toast");
    const alert = out.find((w) => w.term === "alert");
    assert.equal(toast?.weight, 1);
    assert.equal(alert?.weight, 0.6);
  });

  it("expandQuery deduplicates terms, keeping the highest weight", () => {
    // "toast" expands to ["alert", "notification", "snackbar"].
    // "snackbar" expands back to include "toast" at weight 0.6.
    // The original "toast" should win at weight 1.
    const m = buildSynonymMap();
    const out = expandQuery(["toast", "snackbar"], m, 0.6);
    const toast = out.find((w) => w.term === "toast");
    const snackbar = out.find((w) => w.term === "snackbar");
    assert.equal(toast?.weight, 1);
    assert.equal(snackbar?.weight, 1);
  });

  it("expandQuery does not run away (no transitive closure)", () => {
    // toast → alert, alert → warning (if mapped). Without transitive closure,
    // expanding "toast" should NOT include "warning" — only direct synonyms.
    const m = buildSynonymMap(undefined, { alert: ["warning"] });
    const out = expandQuery(["toast"], m, 0.6);
    const warning = out.find((w) => w.term === "warning");
    assert.equal(warning, undefined);
  });
});
