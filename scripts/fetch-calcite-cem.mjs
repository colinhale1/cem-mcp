#!/usr/bin/env node
// Download a Calcite Components release tarball and extract its CEM into
// test/fixtures/calcite.custom-elements.json. We don't add @esri/calcite-components
// to dependencies because we only need the one JSON file.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VERSION = process.env.CALCITE_VERSION ?? "5.0.2";
const DEST = resolve(ROOT, "test/fixtures/calcite.custom-elements.json");
const WORK = resolve(ROOT, ".tmp/calcite-fetch");

async function main() {
  await mkdir(resolve(ROOT, "test/fixtures"), { recursive: true });
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });

  process.stderr.write(`Fetching @esri/calcite-components@${VERSION} ...\n`);
  execFileSync("npm", ["pack", `@esri/calcite-components@${VERSION}`, "--silent"], {
    cwd: WORK,
    stdio: ["ignore", "inherit", "inherit"],
  });

  const tarball = execFileSync("ls", { cwd: WORK }).toString().trim().split("\n")[0];
  if (!tarball) throw new Error("npm pack produced no tarball");

  execFileSync("tar", ["xzf", tarball, "package/dist/docs/api.json"], { cwd: WORK });
  const extracted = resolve(WORK, "package/dist/docs/api.json");
  if (!existsSync(extracted)) {
    throw new Error(`CEM not found in tarball at expected path: ${extracted}`);
  }

  const json = readFileSync(extracted, "utf8");
  await writeFile(DEST, json);
  await rm(WORK, { recursive: true, force: true });
  process.stderr.write(`Wrote ${DEST} (${(json.length / 1024).toFixed(1)} KB)\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-calcite failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
