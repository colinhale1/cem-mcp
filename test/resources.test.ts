// Tests for the MCP resources surface introduced in ADR-0004.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { CemRegistry } from "../src/cem.js";
import {
  CEM_RESOURCE_MIME,
  CEM_URI_SCHEME,
  buildResourceUri,
  listResources,
  parseResourceUri,
  readResource,
} from "../src/resources.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "fixtures/project");

describe("resources: URI parsing", () => {
  it("round-trips a scoped-package URI through build + parse", () => {
    const uri = buildResourceUri("@shoelace-style/shoelace", "sl-button");
    assert.equal(uri, `${CEM_URI_SCHEME}@shoelace-style/shoelace/sl-button`);
    const parsed = parseResourceUri(uri);
    assert.equal(parsed.packageName, "@shoelace-style/shoelace");
    assert.equal(parsed.tagName, "sl-button");
  });

  it("round-trips an unscoped-package URI", () => {
    const uri = buildResourceUri("calcite-components", "calcite-button");
    const parsed = parseResourceUri(uri);
    assert.equal(parsed.packageName, "calcite-components");
    assert.equal(parsed.tagName, "calcite-button");
  });

  it("rejects URIs with the wrong scheme", () => {
    assert.throws(() => parseResourceUri("https://example.com/foo"), /Invalid resource URI scheme/);
  });

  it("rejects URIs missing the tag segment", () => {
    assert.throws(
      () => parseResourceUri(`${CEM_URI_SCHEME}@shoelace-style/shoelace/`),
      /Invalid resource URI/,
    );
  });

  it("rejects URIs missing the package segment", () => {
    assert.throws(() => parseResourceUri(`${CEM_URI_SCHEME}sl-button`), /Invalid resource URI/);
  });
});

describe("resources: listResources + readResource (against fixture)", () => {
  let reg: CemRegistry;

  before(async () => {
    if (!existsSync(PROJECT)) {
      throw new Error(`Fixture missing at ${PROJECT}. Run \`npm run fetch-libs\`.`);
    }
    reg = await CemRegistry.fromProject(PROJECT);
  });

  it("listResources returns one entry per discovered component", async () => {
    const entries = await listResources(reg);
    // Spot-check shape on one well-known component.
    const calciteButton = entries.find((e) => e.uri.endsWith("/calcite-button"));
    assert.ok(calciteButton);
    assert.equal(calciteButton!.name, "calcite-button");
    assert.equal(calciteButton!.mimeType, CEM_RESOURCE_MIME);
    assert.equal(calciteButton!.uri, "cem://@esri/calcite-components/calcite-button");
    // Catalog has >100 entries across the bench libs.
    assert.ok(entries.length > 100, `expected >100 entries, got ${entries.length}`);
  });

  it("readResource returns the compact view for a known URI", async () => {
    const uri = "cem://@esri/calcite-components/calcite-button";
    const text = await readResource(reg, uri);
    assert.match(text, /^# `calcite-button`/m);
    // Compact view, not full — no "## attrs" section heading.
    assert.doesNotMatch(text, /^## attrs/m);
    // Has the locator-style section listings from the compact format.
    assert.match(text, /attrs \(\d+\)/);
  });

  it("readResource on an unknown package raises a descriptive error", async () => {
    await assert.rejects(
      readResource(reg, "cem://@made-up/lib/foo-bar"),
      /Unknown package in resource URI/,
    );
  });

  it("readResource on an unknown tag in a real package raises a descriptive error", async () => {
    await assert.rejects(
      readResource(reg, "cem://@esri/calcite-components/calcite-not-real"),
      /Unknown component/,
    );
  });

  it("readResource is case-insensitive on the tag segment", async () => {
    const text = await readResource(reg, "cem://@esri/calcite-components/CALCITE-BUTTON");
    assert.match(text, /^# `calcite-button`/m);
  });
});
