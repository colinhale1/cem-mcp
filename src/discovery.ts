import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

import { findAdapter, type CemAdapter } from "./adapters/index.js";

export interface DiscoveredPackage {
  name: string;
  version?: string;
  packageDir: string;
  cemPath: string;
  adapter: CemAdapter;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const FALLBACK_CEM_PATHS = [
  "custom-elements.json",
  "dist/custom-elements.json",
  "dist/docs/custom-elements.json",
  "dist/docs/api.json",
];

async function resolveCemForPackage(
  packageDir: string,
  adapters: ReadonlyArray<CemAdapter>,
): Promise<{ cemPath: string; adapter: CemAdapter } | null> {
  const pkgJson = (await readJsonIfExists(join(packageDir, "package.json"))) as {
    customElements?: string;
  } | null;

  const candidates: string[] = [];
  if (pkgJson && typeof pkgJson.customElements === "string") {
    candidates.push(join(packageDir, pkgJson.customElements.replace(/^\.\//, "")));
  }
  for (const rel of FALLBACK_CEM_PATHS) {
    candidates.push(join(packageDir, rel));
  }

  for (const path of candidates) {
    if (!(await exists(path))) continue;
    const parsed = await readJsonIfExists(path);
    if (!parsed) continue;
    const adapter = findAdapter(adapters, parsed);
    if (adapter) return { cemPath: path, adapter };
  }
  return null;
}

async function readPackageMeta(
  packageDir: string,
): Promise<{ name: string; version?: string } | null> {
  const pkg = (await readJsonIfExists(join(packageDir, "package.json"))) as {
    name?: string;
    version?: string;
  } | null;
  if (!pkg || typeof pkg.name !== "string") return null;
  return { name: pkg.name, version: typeof pkg.version === "string" ? pkg.version : undefined };
}

export async function discoverPackages(
  projectRoot: string,
  adapters: ReadonlyArray<CemAdapter>,
): Promise<DiscoveredPackage[]> {
  const nodeModules = resolve(projectRoot, "node_modules");
  if (!(await exists(nodeModules))) return [];

  let entries: string[];
  try {
    entries = await readdir(nodeModules);
  } catch {
    return [];
  }

  const candidateDirs: string[] = [];
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
        candidateDirs.push(join(entryPath, sub));
      }
    } else {
      candidateDirs.push(entryPath);
    }
  }

  const found: DiscoveredPackage[] = [];
  for (const packageDir of candidateDirs) {
    const resolved = await resolveCemForPackage(packageDir, adapters);
    if (!resolved) continue;
    const meta = await readPackageMeta(packageDir);
    if (!meta) continue;
    found.push({ name: meta.name, version: meta.version, packageDir, ...resolved });
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}
