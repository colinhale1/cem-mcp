#!/usr/bin/env node
// Sanity-check what would actually ship to npm:
//   - the files allow-list in package.json produces a tarball
//   - the tarball includes the bin entry, README, LICENSE, CHANGELOG
//   - the bin entry has the #!/usr/bin/env node shebang
//   - the synonyms.json data file made it to dist/
//   - the .d.ts type declarations exported in package.json#exports are present
// Run via `npm run pack:check`.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
}
function ok(msg) {
  console.log(`ok    ${msg}`);
}

// 1. Run `npm pack --dry-run --json` to see the file list that would ship.
const dryRunRaw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: ROOT,
}).toString();
const dryRun = JSON.parse(dryRunRaw);
const entry = Array.isArray(dryRun) ? dryRun[0] : dryRun;
const fileSet = new Set(entry.files.map((f) => f.path));
console.log(
  `Tarball would ship ${entry.files.length} files (${(entry.size / 1024).toFixed(1)} KB).\n`,
);

// 2. Required top-level files.
for (const f of ["package.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
  if (fileSet.has(f)) ok(`ships ${f}`);
  else fail(`tarball missing ${f}`);
}

// 3. Bin entry exists in tarball.
const binPath = pkg.bin?.["cem-mcp"];
if (!binPath) fail("package.json bin entry missing");
else if (fileSet.has(binPath)) ok(`ships bin ${binPath}`);
else fail(`tarball missing declared bin ${binPath}`);

// 4. Synonyms data file made it through (it's imported by src/synonyms.ts).
if (fileSet.has("dist/synonyms.json")) ok("ships dist/synonyms.json");
else fail("tarball missing dist/synonyms.json — synonym map won't load at runtime");

// 5. Type declarations referenced by package.json#exports.
const declaredTypes = new Set();
for (const exp of Object.values(pkg.exports ?? {})) {
  if (typeof exp === "object" && exp.types) declaredTypes.add(exp.types.replace(/^\.\//, ""));
}
if (declaredTypes.size === 0) ok("no exports.types declared (skipping)");
for (const dts of declaredTypes) {
  if (fileSet.has(dts)) ok(`ships type declaration ${dts}`);
  else fail(`tarball missing declared type file ${dts}`);
}

// 6. Bin file has the shebang.
if (binPath) {
  const binFull = resolve(ROOT, binPath);
  try {
    const head = readFileSync(binFull, "utf8").slice(0, 32);
    if (head.startsWith("#!/usr/bin/env node")) ok(`bin ${binPath} has node shebang`);
    else fail(`bin ${binPath} missing #!/usr/bin/env node shebang`);
  } catch {
    fail(`could not read bin ${binPath} — did you run \`npm run build\`?`);
  }
}

// 7. License file content present.
if (fileSet.has("LICENSE")) {
  const lic = readFileSync(resolve(ROOT, "LICENSE"), "utf8");
  if (lic.length > 100) ok(`LICENSE is non-trivial (${lic.length} bytes)`);
  else fail("LICENSE is suspiciously short");
}

// 8. Look for any files in dist/ that didn't get included (catches stale builds).
const distFiles = new Set();
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const rel = full.slice(ROOT.length + 1);
    if (statSync(full).isDirectory()) walk(full);
    else distFiles.add(rel.replace(/\\/g, "/"));
  }
}
try {
  walk(resolve(ROOT, "dist"));
  const missing = [...distFiles].filter((f) => !fileSet.has(f));
  if (missing.length === 0) ok(`every file in dist/ is included (${distFiles.size} files)`);
  else {
    for (const m of missing) console.log(`note  dist file not in tarball: ${m}`);
  }
} catch {
  // No dist directory; nothing to verify.
}

if (process.exitCode) {
  console.error("\npack:check failed.");
  process.exit(1);
} else {
  console.log("\npack:check passed.");
}
