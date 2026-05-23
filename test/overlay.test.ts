// Tests for the per-package overlay scaffolding introduced in ADR-0005.
// Covers: overlay schema validation, merge into LoadedPackage, config v2
// per-package shape, and validate.rules.disable.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { CemRegistry } from "../src/cem.js";
import { applyOverlay, loadOverlay, type OverlayDocument } from "../src/overlay.js";
import { formatElementCompact, formatAspect } from "../src/format.js";
import { validateSnippet } from "../src/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "fixtures/project");

function fixturesPresent(): boolean {
  return existsSync(PROJECT);
}

describe("overlay: schema + load", () => {
  let workdir: string;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), "cem-overlay-"));
  });
  after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("loads a valid overlay file", async () => {
    const path = join(workdir, "valid.json");
    await writeFile(
      path,
      JSON.stringify({
        elements: {
          "acme-button": {
            examples: ['<acme-button variant="primary">Save</acme-button>'],
            usage: "Use inside an acme-form-group.",
          },
        },
      }),
    );
    const { document, sourcePath } = await loadOverlay(path, workdir);
    assert.equal(sourcePath, path);
    assert.equal(document.elements?.["acme-button"].usage, "Use inside an acme-form-group.");
    assert.equal(document.elements?.["acme-button"].examples?.length, 1);
  });

  it("resolves relative paths against baseDir", async () => {
    await writeFile(join(workdir, "rel.json"), JSON.stringify({ elements: {} }));
    const { sourcePath } = await loadOverlay("./rel.json", workdir);
    assert.equal(sourcePath, resolve(workdir, "rel.json"));
  });

  it("rejects unknown top-level keys (strict schema)", async () => {
    const path = join(workdir, "bad-top.json");
    await writeFile(path, JSON.stringify({ extra: "nope" }));
    await assert.rejects(loadOverlay(path, workdir), /Invalid overlay/);
  });

  it("rejects unknown per-element keys", async () => {
    const path = join(workdir, "bad-el.json");
    await writeFile(path, JSON.stringify({ elements: { "acme-x": { notARealField: true } } }));
    await assert.rejects(loadOverlay(path, workdir), /Invalid overlay/);
  });

  it("rejects empty example strings", async () => {
    const path = join(workdir, "bad-ex.json");
    await writeFile(path, JSON.stringify({ elements: { "acme-x": { examples: [""] } } }));
    await assert.rejects(loadOverlay(path, workdir), /Invalid overlay/);
  });

  it("reports a useful error when the file doesn't exist", async () => {
    await assert.rejects(loadOverlay("does-not-exist.json", workdir), /Failed to read overlay/);
  });

  it("reports a useful error on malformed JSON", async () => {
    const path = join(workdir, "broken.json");
    await writeFile(path, "{ not valid json");
    await assert.rejects(loadOverlay(path, workdir), /Failed to read overlay/);
  });
});

describe("overlay: applyOverlay merge", () => {
  it("merges examples + usage onto matching declarations", () => {
    const decl = { tagName: "x-foo" } as Parameters<typeof applyOverlay>[0]["byTag"] extends Map<
      string,
      infer D
    >
      ? D
      : never;
    const pkg = {
      name: "@x/foo",
      byTag: new Map([["x-foo", decl as never]]),
    } as unknown as Parameters<typeof applyOverlay>[0];
    const overlay: OverlayDocument = {
      elements: { "x-foo": { examples: ["<x-foo/>"], usage: "Just use it." } },
    };
    const result = applyOverlay(pkg, overlay);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.unmatched, []);
    const d = pkg.byTag.get("x-foo") as { overlay?: { examples?: string[]; usage?: string } };
    assert.deepEqual(d.overlay?.examples, ["<x-foo/>"]);
    assert.equal(d.overlay?.usage, "Just use it.");
  });

  it("records unmatched tags so the caller can warn about overlay drift", () => {
    const pkg = { name: "@x/foo", byTag: new Map() } as unknown as Parameters<
      typeof applyOverlay
    >[0];
    const overlay: OverlayDocument = {
      elements: { "x-gone": { usage: "Removed in v2." } },
    };
    const result = applyOverlay(pkg, overlay);
    assert.equal(result.matched, 0);
    assert.deepEqual(result.unmatched, ["x-gone"]);
  });
});

describe("config v2 + overlay integration (against calcite fixture)", () => {
  let workdir: string;

  before(async () => {
    if (!fixturesPresent()) return;
    workdir = await mkdtemp(join(tmpdir(), "cem-cfg-"));
    // Overlay augments a real fixture tag (calcite-button).
    const overlayDir = join(workdir, "overlays");
    await mkdir(overlayDir, { recursive: true });
    await writeFile(
      join(overlayDir, "calcite.json"),
      JSON.stringify({
        elements: {
          "calcite-button": {
            examples: [
              '<calcite-button kind="brand">Save</calcite-button>',
              '<calcite-button kind="danger" disabled>Delete</calcite-button>',
            ],
            usage:
              "Always include accessible text content; do not use as icon-only without a label.",
          },
          "calcite-not-real": {
            usage: "This tag will trigger an overlay-drift warning.",
          },
        },
      }),
    );
    // Config points at the overlay via the v2 per-package shape.
    await writeFile(
      join(workdir, "cem.config.json"),
      JSON.stringify({
        packages: {
          "@esri/calcite-components": {
            overlay: "./overlays/calcite.json",
          },
        },
      }),
    );
  });
  after(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("loads per-package overlay through the config and attaches to decls", async (t) => {
    if (!fixturesPresent()) return t.skip("fixture missing");
    const reg = await CemRegistry.fromProject(PROJECT, {
      configPath: join(workdir, "cem.config.json"),
    });
    const pkg = await reg.get("@esri/calcite-components");
    const decl = pkg.byTag.get("calcite-button");
    assert.ok(decl);
    assert.equal(decl!.overlay?.examples?.length, 2);
    assert.ok(decl!.overlay?.usage?.startsWith("Always include accessible text"));
  });

  it("compact view surfaces an examples count and a usage line when overlay supplies them", async (t) => {
    if (!fixturesPresent()) return t.skip("fixture missing");
    const reg = await CemRegistry.fromProject(PROJECT, {
      configPath: join(workdir, "cem.config.json"),
    });
    const pkg = await reg.get("@esri/calcite-components");
    const out = formatElementCompact(pkg.byTag.get("calcite-button")!, pkg.name);
    assert.match(out, /examples \(2\)/);
    assert.match(out, /^Usage: Always include/m);
  });

  it("aspect=examples renders the overlay-supplied snippets in code fences", async (t) => {
    if (!fixturesPresent()) return t.skip("fixture missing");
    const reg = await CemRegistry.fromProject(PROJECT, {
      configPath: join(workdir, "cem.config.json"),
    });
    const pkg = await reg.get("@esri/calcite-components");
    const out = formatAspect(pkg.byTag.get("calcite-button")!, "examples", pkg.name);
    assert.match(out, /calcite-button kind="brand"/);
    assert.match(out, /calcite-button kind="danger" disabled/);
  });

  it("returns '(none)' for aspect=examples when no overlay is configured", async () => {
    if (!fixturesPresent()) return;
    // Use a fresh registry with no config — no overlay → no examples.
    const reg = await CemRegistry.fromProject(PROJECT);
    const pkg = await reg.get("@esri/calcite-components");
    const out = formatAspect(pkg.byTag.get("calcite-button")!, "examples", pkg.name);
    assert.match(out, /\(none\)/);
  });

  it("v1 top-level `paths` still works (back-compat)", async (t) => {
    if (!fixturesPresent()) return t.skip("fixture missing");
    // Build a v1-style config that uses the old `paths` shape only.
    const v1Dir = await mkdtemp(join(tmpdir(), "cem-v1-"));
    try {
      await writeFile(join(v1Dir, "cem.config.json"), JSON.stringify({ paths: {} }));
      const reg = await CemRegistry.fromProject(PROJECT, {
        configPath: join(v1Dir, "cem.config.json"),
      });
      assert.ok(reg.packageNames().includes("@esri/calcite-components"));
    } finally {
      await rm(v1Dir, { recursive: true, force: true });
    }
  });
});

describe("validate.rules.disable (rule registry toggle)", () => {
  it("skips invalid-value when disabled but still flags unknown-attr", async (t) => {
    if (!fixturesPresent()) return t.skip("fixture missing");
    const workdir = await mkdtemp(join(tmpdir(), "cem-rules-"));
    try {
      await writeFile(
        join(workdir, "cem.config.json"),
        JSON.stringify({ validate: { rules: { disable: ["invalid-value"] } } }),
      );
      const reg = await CemRegistry.fromProject(PROJECT, {
        configPath: join(workdir, "cem.config.json"),
      });
      const snippet = `<calcite-button kind="totallyBogus" alignmnt="x">y</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      // The unknown-attr issue still fires.
      assert.ok(r.issues.some((i) => i.kind === "unknown-attr"));
      // The invalid-value issue is suppressed.
      assert.equal(
        r.issues.find((i) => i.kind === "invalid-value"),
        undefined,
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("disabling unknown-tag suppresses tag errors while attr checks remain", async (t) => {
    if (!fixturesPresent()) return t.skip("fixture missing");
    const workdir = await mkdtemp(join(tmpdir(), "cem-rules-"));
    try {
      await writeFile(
        join(workdir, "cem.config.json"),
        JSON.stringify({ validate: { rules: { disable: ["unknown-tag"] } } }),
      );
      const reg = await CemRegistry.fromProject(PROJECT, {
        configPath: join(workdir, "cem.config.json"),
      });
      const snippet = `<calcite-totallyfake></calcite-totallyfake><calcite-button alignmnt="x">y</calcite-button>`;
      const r = await validateSnippet(reg, snippet);
      assert.equal(
        r.issues.find((i) => i.kind === "unknown-tag"),
        undefined,
      );
      assert.ok(r.issues.some((i) => i.kind === "unknown-attr"));
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
