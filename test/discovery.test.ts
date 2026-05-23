import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinAdapters } from "../src/adapters/index.js";
import { discoverPackages } from "../src/discovery.js";

async function writeFixture(structure: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cem-mcp-disc-"));
  for (const [rel, body] of Object.entries(structure)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

describe("discovery", () => {
  it("finds a standard CEM 2.x package via the customElements field", async () => {
    const root = await writeFixture({
      "node_modules/foo-lib/package.json": {
        name: "foo-lib",
        version: "1.2.3",
        customElements: "custom-elements.json",
      },
      "node_modules/foo-lib/custom-elements.json": {
        schemaVersion: "2.1.0",
        modules: [
          {
            kind: "javascript-module",
            path: "src/foo.ts",
            declarations: [{ kind: "class", name: "Foo", tagName: "foo-bar" }],
          },
        ],
      },
    });

    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "foo-lib");
    assert.equal(found[0].version, "1.2.3");
    assert.equal(found[0].adapter.name, "cem2");
  });

  it("falls back to dist/docs/api.json when customElements is not declared", async () => {
    const root = await writeFixture({
      "node_modules/sten-lib/package.json": { name: "sten-lib", version: "0.1.0" },
      "node_modules/sten-lib/dist/docs/api.json": {
        schemaVersion: "2.1.0",
        modules: [],
      },
    });
    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 1);
    assert.equal(found[0].cemPath.endsWith("dist/docs/api.json"), true);
  });

  it("normalizes a leading ./ in the customElements field", async () => {
    const root = await writeFixture({
      "node_modules/dot-lib/package.json": {
        name: "dot-lib",
        customElements: "./custom-elements.json",
      },
      "node_modules/dot-lib/custom-elements.json": { schemaVersion: "2.1.0", modules: [] },
    });
    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 1);
  });

  it("rejects VS Code HTML custom-data files when only cem2 adapter is enabled", async () => {
    const root = await writeFixture({
      "node_modules/htmldata-lib/package.json": { name: "htmldata-lib" },
      "node_modules/htmldata-lib/custom-elements.json": {
        version: "experimental",
        tags: [{ name: "fake-tag" }],
      },
    });
    const cem2Only = builtinAdapters.filter((a) => a.name === "cem2");
    const found = await discoverPackages(root, cem2Only);
    assert.equal(found.length, 0);
  });

  it("accepts VS Code HTML custom-data when the carbon adapter is enabled", async () => {
    const root = await writeFixture({
      "node_modules/htmldata-lib/package.json": { name: "htmldata-lib" },
      "node_modules/htmldata-lib/custom-elements.json": {
        version: "experimental",
        tags: [{ name: "x-foo" }],
      },
    });
    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 1);
    assert.equal(found[0].adapter.name, "carbon-html-data");
  });

  it("scans @scoped packages", async () => {
    const root = await writeFixture({
      "node_modules/@acme/widgets/package.json": {
        name: "@acme/widgets",
        customElements: "custom-elements.json",
      },
      "node_modules/@acme/widgets/custom-elements.json": { schemaVersion: "2.1.0", modules: [] },
    });
    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "@acme/widgets");
  });

  it("skips packages with no manifest at any candidate path", async () => {
    const root = await writeFixture({
      "node_modules/nope/package.json": { name: "nope", version: "1.0.0" },
    });
    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 0);
  });

  it("returns empty when node_modules is missing", async () => {
    const root = await writeFixture({ "package.json": { name: "host" } });
    const found = await discoverPackages(root, builtinAdapters);
    assert.equal(found.length, 0);
  });
});
