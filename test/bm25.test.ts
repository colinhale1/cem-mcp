import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildBm25Index, scoreBm25 } from "../src/bm25.js";

describe("BM25", () => {
  const docs = new Map<string, string[]>([
    ["alert", ["temporary", "toast", "notification", "banner", "message"]],
    ["dialog", ["modal", "overlay", "dialog", "content"]],
    ["loader", ["loading", "spinner", "progress", "indicator"]],
    ["button", ["clickable", "action", "form", "submit"]],
  ]);

  it("indexes term frequencies and document frequencies", () => {
    const idx = buildBm25Index(docs);
    assert.equal(idx.totalDocs, 4);
    // "temporary" appears in one doc only.
    assert.equal(idx.terms.get("temporary")?.df, 1);
    assert.equal(idx.terms.get("temporary")?.postings.get("alert"), 1);
    // doc lengths are tracked.
    assert.equal(idx.docLengths.get("alert"), 5);
  });

  it("scores rare terms higher than common terms", () => {
    const allDocs = new Map<string, string[]>([
      ["a", ["common", "rare", "x"]],
      ["b", ["common", "y"]],
      ["c", ["common", "z"]],
      ["d", ["common", "w"]],
    ]);
    const idx = buildBm25Index(allDocs);
    const rareScores = scoreBm25(idx, [{ term: "rare", weight: 1 }]);
    const commonScores = scoreBm25(idx, [{ term: "common", weight: 1 }]);
    // The rare term lives only in doc "a" and should score higher than the
    // common term's contribution to any single doc.
    assert.ok((rareScores.get("a") ?? 0) > 0);
    assert.ok((rareScores.get("a") ?? 0) > (commonScores.get("a") ?? 0));
  });

  it("returns the document with the best matching terms as top score", () => {
    const idx = buildBm25Index(docs);
    const scores = scoreBm25(idx, [
      { term: "toast", weight: 1 },
      { term: "notification", weight: 1 },
    ]);
    const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    assert.equal(ranked[0][0], "alert");
  });

  it("respects per-term weight", () => {
    const idx = buildBm25Index(docs);
    const heavy = scoreBm25(idx, [{ term: "toast", weight: 1 }]).get("alert") ?? 0;
    const light = scoreBm25(idx, [{ term: "toast", weight: 0.5 }]).get("alert") ?? 0;
    assert.ok(Math.abs(heavy / light - 2) < 0.001);
  });

  it("returns empty results for a query with no known terms", () => {
    const idx = buildBm25Index(docs);
    const out = scoreBm25(idx, [{ term: "nothinghere", weight: 1 }]);
    assert.equal(out.size, 0);
  });

  it("survives an empty index", () => {
    const idx = buildBm25Index(new Map());
    assert.equal(idx.totalDocs, 0);
    assert.equal(scoreBm25(idx, [{ term: "x", weight: 1 }]).size, 0);
  });
});
