import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPackageFilter, loadConfig } from "../src/config.js";
import { CemRegistry } from "../src/cem.js";

async function projectWith(structure: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cem-mcp-cfg-"));
  for (const [rel, body] of Object.entries(structure)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

function makePkg(name: string) {
  return {
    [`node_modules/${name}/package.json`]: { name, customElements: "custom-elements.json" },
    [`node_modules/${name}/custom-elements.json`]: {
      schemaVersion: "2.1.0",
      modules: [
        {
          kind: "javascript-module",
          path: "src/x.ts",
          declarations: [
            { kind: "class", name: "X", tagName: `${name.replace(/[@/]/g, "")}-x` },
          ],
        },
      ],
    },
  };
}

describe("config", () => {
  it("loadConfig returns empty config when no file exists", async () => {
    const root = await projectWith({});
    const c = await loadConfig(root);
    assert.equal(c.sourcePath, null);
    assert.deepEqual(c.config, {});
  });

  it("loadConfig reads cem.config.json from the project root", async () => {
    const root = await projectWith({
      "cem.config.json": { packages: { exclude: ["bad"] } },
    });
    const c = await loadConfig(root);
    assert.deepEqual(c.config.packages, { exclude: ["bad"] });
    assert.equal(c.sourcePath?.endsWith("cem.config.json"), true);
  });

  it("loadConfig rejects unknown fields strictly", async () => {
    const root = await projectWith({
      "cem.config.json": { madeUp: true },
    });
    await assert.rejects(loadConfig(root), /Invalid config/);
  });

  it("applyPackageFilter respects include and exclude", () => {
    const names = ["@a/one", "@a/two", "@b/three"];
    assert.deepEqual(applyPackageFilter(names, undefined), names);
    assert.deepEqual(
      applyPackageFilter(names, { include: ["@a/one", "@a/two"] }),
      ["@a/one", "@a/two"],
    );
    assert.deepEqual(applyPackageFilter(names, { exclude: ["@a/two"] }), ["@a/one", "@b/three"]);
    assert.deepEqual(
      applyPackageFilter(names, { include: ["@a/one", "@a/two"], exclude: ["@a/two"] }),
      ["@a/one"],
    );
  });

  it("registry applies the exclude list at discovery time", async () => {
    const root = await projectWith({
      ...makePkg("keepme"),
      ...makePkg("dropme"),
      "cem.config.json": { packages: { exclude: ["dropme"] } },
    });
    const reg = await CemRegistry.fromProject(root);
    assert.deepEqual(reg.packageNames(), ["keepme"]);
  });

  it("registry applies an include allow-list", async () => {
    const root = await projectWith({
      ...makePkg("alpha"),
      ...makePkg("beta"),
      ...makePkg("gamma"),
      "cem.config.json": { packages: { include: ["alpha", "gamma"] } },
    });
    const reg = await CemRegistry.fromProject(root);
    assert.deepEqual(reg.packageNames(), ["alpha", "gamma"]);
  });

  it("registry registers manual paths from config in addition to discovery", async () => {
    const root = await projectWith({
      ...makePkg("discovered-lib"),
      "vendor/manual-cem.json": {
        schemaVersion: "2.1.0",
        modules: [
          {
            kind: "javascript-module",
            path: "x.ts",
            declarations: [{ kind: "class", name: "M", tagName: "manual-foo" }],
          },
        ],
      },
      "cem.config.json": {
        paths: { "@manual/lib": "./vendor/manual-cem.json" },
      },
    });
    const reg = await CemRegistry.fromProject(root);
    assert.deepEqual(reg.packageNames(), ["@manual/lib", "discovered-lib"]);
    const pkg = await reg.get("@manual/lib");
    assert.equal(pkg.byTag.has("manual-foo"), true);
  });

  it("registry fails fast on a misconfigured manual path", async () => {
    const root = await projectWith({
      "cem.config.json": { paths: { "@nope/x": "./does-not-exist.json" } },
    });
    await assert.rejects(CemRegistry.fromProject(root), /not found/);
  });

  it("registry can disable the carbon adapter via config", async () => {
    const root = await projectWith({
      "node_modules/htmldata-lib/package.json": {
        name: "htmldata-lib",
        customElements: "custom-elements.json",
      },
      "node_modules/htmldata-lib/custom-elements.json": {
        version: "experimental",
        tags: [{ name: "x-foo" }],
      },
      "cem.config.json": { adapters: { disable: ["carbon-html-data"] } },
    });
    const reg = await CemRegistry.fromProject(root);
    assert.deepEqual(reg.packageNames(), []);
  });
});
