import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  builtinAdapters,
  findAdapter,
  selectAdapters,
} from "../src/adapters/index.js";
import { cem2Adapter } from "../src/adapters/cem2.js";
import { carbonHtmlDataAdapter } from "../src/adapters/carbon-html-data.js";

describe("adapters", () => {
  it("cem2 matches standard CEM 2.x and identity-loads", () => {
    const manifest = { schemaVersion: "2.1.0", modules: [] };
    assert.equal(cem2Adapter.matches(manifest), true);
    assert.equal(cem2Adapter.load(manifest, "/tmp/x.json"), manifest);
  });

  it("cem2 rejects non-CEM shapes", () => {
    assert.equal(cem2Adapter.matches({ tags: [], version: "experimental" }), false);
    assert.equal(cem2Adapter.matches(null), false);
    assert.equal(cem2Adapter.matches({ modules: "not-an-array" }), false);
  });

  it("carbon-html-data matches VS Code HTML custom-data shape", () => {
    const data = { version: "experimental", tags: [{ name: "cds-foo" }] };
    assert.equal(carbonHtmlDataAdapter.matches(data), true);
  });

  it("carbon-html-data refuses files that ALSO have a modules array (claimed by cem2)", () => {
    assert.equal(
      carbonHtmlDataAdapter.matches({ version: "1.0", tags: [], modules: [] }),
      false,
    );
  });

  it("carbon-html-data converts tags + attributes to a CEM declaration", () => {
    const data = {
      version: "experimental",
      tags: [
        {
          name: "cds-button",
          description: "A button.",
          attributes: [
            { name: "disabled", type: "boolean", default: "false", description: "Disable it." },
            { name: "size", values: [{ name: "sm" }, { name: "md" }, { name: "lg" }] },
          ],
        },
      ],
    };
    const m = carbonHtmlDataAdapter.load(data, "/tmp/carbon.json");
    assert.equal(m.schemaVersion, "2.1.0");
    assert.equal(m.modules.length, 1);
    const decls = m.modules[0].declarations!;
    assert.equal(decls.length, 1);
    const d = decls[0];
    assert.equal(d.tagName, "cds-button");
    assert.equal(d.name, "CdsButton");
    assert.equal(d.customElement, true);
    assert.equal(d.description, "A button.");
    assert.equal(d.attributes!.length, 2);
    assert.equal(d.attributes![0].type?.text, "boolean");
    assert.equal(d.attributes![0].default, "false");
    assert.equal(d.attributes![1].type?.text, '"sm" | "md" | "lg"');
  });

  it("findAdapter returns the first matching adapter; cem2 wins ties", () => {
    const carbonLike = { version: "experimental", tags: [] };
    const a = findAdapter(builtinAdapters, carbonLike);
    assert.equal(a?.name, "carbon-html-data");

    const cem = { schemaVersion: "2.1.0", modules: [] };
    assert.equal(findAdapter(builtinAdapters, cem)?.name, "cem2");
  });

  it("findAdapter returns null when nothing matches and swallows matcher exceptions", () => {
    assert.equal(findAdapter(builtinAdapters, { something: "else" }), null);
    const throwing = {
      name: "throws",
      matches() {
        throw new Error("boom");
      },
      load() {
        throw new Error("never called");
      },
    };
    const adapters = [throwing, cem2Adapter];
    const cem = { schemaVersion: "2.1.0", modules: [] };
    assert.equal(findAdapter(adapters, cem)?.name, "cem2");
  });

  it("selectAdapters honors the disable list", () => {
    const onlyCem2 = selectAdapters(builtinAdapters, ["carbon-html-data"]);
    assert.equal(onlyCem2.length, 1);
    assert.equal(onlyCem2[0].name, "cem2");
  });
});
