#!/usr/bin/env node
// Fetch a configurable list of web-component packages and lay each one out
// under test/fixtures/project/node_modules/... so discovery can find them.
//
// Skips packages that don't declare a `customElements` field in package.json
// and don't ship a manifest at one of the fallback paths. Prints a one-line
// summary per package so it's obvious which libraries are in the bench set.

import { mkdir, writeFile, rm, copyFile, readFile, stat } from "node:fs/promises";
import { execFileSync, execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROJECT = resolve(ROOT, "test/fixtures/project");
const NM = resolve(PROJECT, "node_modules");
const WORK = resolve(ROOT, ".tmp/multi-fetch");

// Packages to fetch. Pinned where stability matters; floating @latest where we
// just want whatever ships today. The bench is honest about whatever ships.
const LIBS = [
  "@esri/calcite-components@5.0.2",
  "@shoelace-style/shoelace@2.20.1",
  "@patternfly/elements@5.0.0",
  "@rhds/elements@4.1.3",
  "@nordhealth/components@4.0.0",
  "@vonage/vivid@5.19.0",
  // Note: @microsoft/fast-foundation ships a schema 1.0 CEM with framework
  // primitives (templates, controllers) but no `tagName` on any declaration;
  // Microsoft's actual component package (@microsoft/fast-components) was
  // deprecated. Not useful for the bench.
  "@ui5/webcomponents@2.18.0",
  "@carbon/web-components@2.41.0",
  "@cds/core@6.17.0",
];

const FALLBACK_CEM_PATHS = [
  "custom-elements.json",
  "dist/custom-elements.json",
  "dist/docs/custom-elements.json",
  "dist/docs/api.json",
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

function packToWork(spec) {
  const workDir = resolve(WORK, spec.replace(/[^a-zA-Z0-9.-]+/g, "_"));
  rmSyncSafe(workDir);
  mkdirSync(workDir);
  execFileSync("npm", ["pack", spec, "--silent"], {
    cwd: workDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const files = readdirSync(workDir).filter((f) => f.endsWith(".tgz"));
  if (files.length === 0) throw new Error(`no tarball for ${spec}`);
  return { workDir, tarball: files[0] };
}

function rmSyncSafe(p) {
  try {
    execFileSync("rm", ["-rf", p]);
  } catch {}
}

function mkdirSync(p) {
  execFileSync("mkdir", ["-p", p]);
}

async function extractAndPlace(spec) {
  const { workDir, tarball } = packToWork(spec);

  // List tarball to find package.json + any candidate manifest paths.
  const listing = execFileSync("tar", ["tzf", tarball], { cwd: workDir })
    .toString()
    .trim()
    .split("\n");

  // Standard prefix is "package/". Extract package.json first to find the
  // declared manifest path.
  if (!listing.includes("package/package.json")) {
    throw new Error("tarball missing package.json");
  }
  execFileSync("tar", ["xzf", tarball, "package/package.json"], { cwd: workDir });
  const pkg = await readJson(resolve(workDir, "package/package.json"));
  if (!pkg || typeof pkg.name !== "string") throw new Error("invalid package.json");

  let manifestRel = null;
  if (typeof pkg.customElements === "string") {
    // Some packages declare "./custom-elements.json" — strip the leading ./
    manifestRel = pkg.customElements.replace(/^\.\//, "");
  }
  if (!manifestRel) {
    for (const rel of FALLBACK_CEM_PATHS) {
      if (listing.includes(`package/${rel}`)) {
        manifestRel = rel;
        break;
      }
    }
  }
  if (!manifestRel) {
    return { name: pkg.name, version: pkg.version, ok: false, reason: "no CEM declared or found" };
  }
  if (!listing.includes(`package/${manifestRel}`)) {
    return {
      name: pkg.name,
      version: pkg.version,
      ok: false,
      reason: `declared manifest ${manifestRel} not in tarball`,
    };
  }

  execFileSync("tar", ["xzf", tarball, `package/${manifestRel}`], { cwd: workDir });

  // Place into the fixture project under node_modules/<name>/...
  const targetDir = resolve(NM, pkg.name);
  rmSyncSafe(targetDir);
  await mkdir(resolve(targetDir, dirname(manifestRel)), { recursive: true });
  await copyFile(
    resolve(workDir, "package/package.json"),
    resolve(targetDir, "package.json"),
  );
  await copyFile(
    resolve(workDir, "package", manifestRel),
    resolve(targetDir, manifestRel),
  );

  const size = (await stat(resolve(targetDir, manifestRel))).size;
  return { name: pkg.name, version: pkg.version, ok: true, manifestRel, size };
}

async function main() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await mkdir(NM, { recursive: true });

  // Write a host package.json listing every spec as a dep, for realism.
  const deps = {};
  for (const spec of LIBS) {
    const at = spec.lastIndexOf("@");
    const name = spec.startsWith("@") ? spec.slice(0, spec.indexOf("@", 1)) : spec.slice(0, at);
    const ver = spec.slice(name.length + 1) || "latest";
    deps[name] = ver;
  }
  await writeFile(
    resolve(PROJECT, "package.json"),
    JSON.stringify(
      { name: "cem-mcp-fixture-project", private: true, version: "0.0.0", dependencies: deps },
      null,
      2,
    ) + "\n",
  );

  const results = [];
  for (const spec of LIBS) {
    process.stderr.write(`Fetching ${spec} ... `);
    try {
      const r = await extractAndPlace(spec);
      results.push(r);
      if (r.ok) {
        process.stderr.write(
          `ok (${r.name}@${r.version}, ${(r.size / 1024).toFixed(0)} KB at ${r.manifestRel})\n`,
        );
      } else {
        process.stderr.write(`skip — ${r.reason}\n`);
      }
    } catch (err) {
      process.stderr.write(`FAIL — ${err?.message ?? err}\n`);
      results.push({ name: spec, ok: false, reason: String(err?.message ?? err) });
    }
  }

  const installed = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);
  process.stderr.write(`\nInstalled ${installed.length}/${results.length} packages.\n`);
  if (skipped.length) {
    process.stderr.write("Skipped:\n");
    for (const r of skipped) process.stderr.write(`  - ${r.name}: ${r.reason}\n`);
  }

  await rm(WORK, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`fetch-libs failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
