// Coverage for the scoring channels introduced for paraphrastic and
// attribute-anchored queries: attribute index population, attribute-anchored
// query detection + value-coverage scoring, the token-to-tag boost (synonym
// route landing on a kebab token that names a component), and the
// integration that BM25 is suppressed when attribute-anchored fires.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CemRegistry, searchElements } from "../src/cem.js";

async function fixtureProject(structure: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cem-mcp-scoring-"));
  for (const [rel, body] of Object.entries(structure)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

function lib(
  decls: Array<{
    tag: string;
    description?: string;
    attributes?: Array<{ name: string; values?: string[]; description?: string }>;
  }>,
) {
  return {
    "node_modules/scoring-lib/package.json": {
      name: "scoring-lib",
      customElements: "custom-elements.json",
    },
    "node_modules/scoring-lib/custom-elements.json": {
      schemaVersion: "2.1.0",
      modules: [
        {
          kind: "javascript-module",
          path: "src/x.ts",
          declarations: decls.map((d) => ({
            kind: "class",
            name: d.tag
              .split("-")
              .map((t) => t[0].toUpperCase() + t.slice(1))
              .join(""),
            tagName: d.tag,
            customElement: true,
            description: d.description,
            attributes: (d.attributes ?? []).map((a) => ({
              name: a.name,
              description: a.description,
              type: a.values ? { text: a.values.map((v) => `"${v}"`).join(" | ") } : undefined,
            })),
          })),
        },
      ],
    },
  };
}

describe("attribute index", () => {
  it("populates attrIndex from declared attributes", async () => {
    const root = await fixtureProject(
      lib([
        { tag: "lib-a", attributes: [{ name: "scale", values: ["s", "m", "l"] }] },
        { tag: "lib-b", attributes: [{ name: "scale", values: ["sm", "lg"] }] },
        { tag: "lib-c", attributes: [{ name: "color", values: ["red", "blue"] }] },
      ]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    assert.equal(pkg.attrIndex.get("scale")?.size, 2);
    assert.equal(pkg.attrIndex.get("color")?.size, 1);
    assert.deepEqual(Array.from(pkg.attrValuesByTag.get("lib-a")?.get("scale") ?? []).sort(), [
      "l",
      "m",
      "s",
    ]);
  });

  it("extracts values from type.text union of quoted strings", async () => {
    const root = await fixtureProject(
      lib([{ tag: "lib-x", attributes: [{ name: "size", values: ["small", "medium", "large"] }] }]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    assert.deepEqual(Array.from(pkg.attrValuesByTag.get("lib-x")?.get("size") ?? []).sort(), [
      "large",
      "medium",
      "small",
    ]);
  });
});

describe("attribute-anchored scoring", () => {
  it("activates when the head token names an attribute shared by ≥2 components", async () => {
    const root = await fixtureProject(
      lib([
        { tag: "lib-button", attributes: [{ name: "scale", values: ["s", "m", "l"] }] },
        { tag: "lib-icon", attributes: [{ name: "scale", values: ["s", "m", "l"] }] },
        { tag: "lib-input", attributes: [{ name: "scale", values: ["s", "m", "l"] }] },
        { tag: "lib-unrelated", attributes: [] },
      ]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    const hits = searchElements(pkg, "scale s m l", 10);
    const tags = hits.map((h) => h.decl.tagName);
    assert.equal(tags.length, 3, "only the 3 components with scale should match");
    assert.ok(!tags.includes("lib-unrelated"));
  });

  it("does not activate when only one component has the attribute", async () => {
    const root = await fixtureProject(
      lib([
        { tag: "lib-button", attributes: [{ name: "unique", values: ["a", "b"] }] },
        { tag: "lib-icon", attributes: [{ name: "scale", values: ["s", "m"] }] },
      ]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    const hits = searchElements(pkg, "unique a b", 10);
    // Single-component attributes don't trigger the category channel; we just
    // get whatever BM25 + tag fuzzy returns, with no fixed attr boost.
    for (const h of hits) {
      assert.ok(!h.reasons.some((r) => r.includes("attribute 'unique'")));
    }
  });

  it("scores by value coverage: full match outranks partial match", async () => {
    const root = await fixtureProject(
      lib([
        { tag: "lib-full", attributes: [{ name: "scale", values: ["s", "m", "l"] }] },
        { tag: "lib-partial", attributes: [{ name: "scale", values: ["s"] }] },
      ]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    const hits = searchElements(pkg, "scale s m l", 10);
    assert.equal(hits[0].decl.tagName, "lib-full");
  });
});

describe("token-to-tag boost", () => {
  it("lifts a component when an original query token names a kebab part of its tag", async () => {
    const root = await fixtureProject(
      lib([
        { tag: "lib-banner", description: "" },
        { tag: "lib-card", description: "A card." },
      ]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    // "banner" matches lib-banner's tag token; lib-card has no relevant tokens.
    const hits = searchElements(pkg, "show a banner", 5);
    assert.equal(hits[0].decl.tagName, "lib-banner");
    assert.ok(hits[0].reasons.some((r) => r.includes("token 'banner' matches tag")));
  });

  it("lifts a component via synonym expansion that lands on its tag", async () => {
    // lib-accordion has empty description; the only signal for it is the
    // tag itself. Query "expandable" routes through the synonym map to
    // "accordion" and the boost picks up the tag-token hit.
    const root = await fixtureProject(
      lib([
        { tag: "lib-accordion", description: "" },
        { tag: "lib-block-section", description: "A section of a block." },
      ]),
    );
    const reg = await CemRegistry.fromProject(root);
    const pkg = await reg.get("scoring-lib");
    const hits = searchElements(pkg, "expandable", 5);
    assert.equal(hits[0].decl.tagName, "lib-accordion");
    assert.ok(hits[0].reasons.some((r) => r.includes("synonym 'accordion' matches tag")));
  });
});
