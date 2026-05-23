#!/usr/bin/env node
// Download a Calcite Components release tarball and lay it out under
// test/fixtures/project/node_modules/@esri/calcite-components so the discovery
// code can find it via a realistic node_modules tree. We don't add
// @esri/calcite-components to dependencies — we only need the package.json and
// the CEM file it references.

import { mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VERSION = process.env.CALCITE_VERSION ?? "5.0.2";
const PROJECT = resolve(ROOT, "test/fixtures/project");
const PKG_DIR = resolve(PROJECT, "node_modules/@esri/calcite-components");
const WORK = resolve(ROOT, ".tmp/calcite-fetch");

async function main() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await rm(PKG_DIR, { recursive: true, force: true });
  await mkdir(resolve(PKG_DIR, "dist/docs"), { recursive: true });

  process.stderr.write(`Fetching @esri/calcite-components@${VERSION} ...\n`);
  execFileSync("npm", ["pack", `@esri/calcite-components@${VERSION}`, "--silent"], {
    cwd: WORK,
    stdio: ["ignore", "inherit", "inherit"],
  });

  const tarball = execFileSync("ls", { cwd: WORK }).toString().trim().split("\n")[0];
  if (!tarball) throw new Error("npm pack produced no tarball");

  execFileSync("tar", ["xzf", tarball, "package/package.json", "package/dist/docs/api.json"], {
    cwd: WORK,
  });
  const pkgJsonSrc = resolve(WORK, "package/package.json");
  const cemSrc = resolve(WORK, "package/dist/docs/api.json");
  if (!existsSync(pkgJsonSrc) || !existsSync(cemSrc)) {
    throw new Error("Expected files not found in tarball");
  }

  await copyFile(pkgJsonSrc, resolve(PKG_DIR, "package.json"));
  await copyFile(cemSrc, resolve(PKG_DIR, "dist/docs/api.json"));

  // Minimal host project package.json so discovery has a sensible root.
  const hostPkg = {
    name: "cem-mcp-fixture-project",
    private: true,
    version: "0.0.0",
    dependencies: { "@esri/calcite-components": VERSION },
  };
  await writeFile(resolve(PROJECT, "package.json"), JSON.stringify(hostPkg, null, 2) + "\n");

  const size = readFileSync(resolve(PKG_DIR, "dist/docs/api.json")).length;
  await rm(WORK, { recursive: true, force: true });
  process.stderr.write(
    `Wrote fixture at ${PROJECT} (calcite CEM ${(size / 1024).toFixed(1)} KB)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fetch-calcite failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
