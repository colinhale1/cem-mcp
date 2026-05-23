import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

export interface DiscoveredPackage {
  name: string;
  version?: string;
  packageDir: string; // absolute path to the package directory
  cemPath: string; // absolute path to the custom-elements manifest JSON
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// A package may publish its CEM via the `customElements` package.json field
// (the standard convention). As a fallback we look for a handful of common
// filenames at the package root or under dist/.
const FALLBACK_CEM_PATHS = [
  "custom-elements.json",
  "dist/custom-elements.json",
  "dist/docs/custom-elements.json",
  "dist/docs/api.json", // Stencil convention (e.g. Calcite)
];

// A file at `path` qualifies as a CEM 2.x manifest only if it parses as JSON
// with a `modules` array. Some packages ship VS Code HTML custom-data files at
// names like `custom-elements.json` (e.g. @carbon/web-components) — same name,
// completely different schema — so we have to look inside rather than trust
// the filename.
async function looksLikeCemManifest(path: string): Promise<boolean> {
  const parsed = await readJsonIfExists(path);
  return !!parsed && Array.isArray((parsed as { modules?: unknown }).modules);
}

async function resolveCemPath(packageDir: string): Promise<string | null> {
  const pkgJson = await readJsonIfExists(join(packageDir, "package.json"));
  if (pkgJson && typeof pkgJson.customElements === "string") {
    const declared = join(packageDir, pkgJson.customElements.replace(/^\.\//, ""));
    if ((await exists(declared)) && (await looksLikeCemManifest(declared))) {
      return declared;
    }
  }
  for (const rel of FALLBACK_CEM_PATHS) {
    const p = join(packageDir, rel);
    if ((await exists(p)) && (await looksLikeCemManifest(p))) return p;
  }
  return null;
}

async function readPackageMeta(
  packageDir: string,
): Promise<{ name: string; version?: string } | null> {
  const pkg = await readJsonIfExists(join(packageDir, "package.json"));
  if (!pkg || typeof pkg.name !== "string") return null;
  return { name: pkg.name, version: typeof pkg.version === "string" ? pkg.version : undefined };
}

// Walks node_modules at the project root, including @scoped/* directories,
// and returns every package that ships a Custom Elements Manifest.
export async function discoverPackages(projectRoot: string): Promise<DiscoveredPackage[]> {
  const nodeModules = resolve(projectRoot, "node_modules");
  if (!(await exists(nodeModules))) return [];

  const found: DiscoveredPackage[] = [];
  let entries: string[];
  try {
    entries = await readdir(nodeModules);
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const entryPath = join(nodeModules, entry);
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = await readdir(entryPath);
      } catch {
        continue;
      }
      for (const sub of scoped) {
        if (sub.startsWith(".")) continue;
        candidates.push(join(entryPath, sub));
      }
    } else {
      candidates.push(entryPath);
    }
  }

  for (const packageDir of candidates) {
    const cemPath = await resolveCemPath(packageDir);
    if (!cemPath) continue;
    const meta = await readPackageMeta(packageDir);
    if (!meta) continue;
    found.push({ name: meta.name, version: meta.version, packageDir, cemPath });
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}
