import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";

// User-editable configuration. Optional — sensible defaults take over when no
// file is found. Discovery looks for `cem.config.json` in the project root by
// default, or wherever `--config <path>` points.

// Per-package config — the v2 shape introduced in ADR-0005. Allows path
// override (previously only available via top-level `paths`) and overlay
// reference (new). Both top-level `paths` and per-package `path` are valid;
// the per-package form wins when both are set for the same name.
const PackageConfigSchema = z
  .object({
    /** CEM manifest path, relative to the config file's directory. */
    path: z.string().optional(),
    /** Overlay file path, relative to the config file's directory. See ADR-0005. */
    overlay: z.string().optional(),
  })
  .strict();

export type PackageConfig = z.infer<typeof PackageConfigSchema>;

// `packages` is a mixed map: include/exclude carry filter arrays, all other
// keys are per-package configs. Catchall validates everything not in the
// known-key list against the per-package shape.
const PackagesSchema = z
  .object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  })
  .catchall(PackageConfigSchema);

const ConfigSchema = z
  .object({
    /**
     * Override which packages discovery is allowed to register.
     * - `include`: if set, ONLY these packages are registered (allow-list).
     * - `exclude`: packages to drop from discovery (deny-list).
     *
     * Other keys on this object are treated as per-package config (path,
     * overlay). See ADR-0005.
     */
    packages: PackagesSchema.optional(),

    /**
     * Manual package → manifest path mapping. Paths are resolved relative to
     * the config file's directory. Use this for CEMs that live outside
     * `node_modules` (vendored builds, monorepo siblings, etc.). Manual
     * entries are added in addition to discovered ones; the manual path wins
     * if a package is both discovered and manually registered.
     *
     * Equivalent to setting `packages.<name>.path`. The per-package form is
     * preferred for new configs but this top-level shape stays valid for
     * backwards compatibility.
     */
    paths: z.record(z.string()).optional(),

    /**
     * Adapter controls.
     * - `disable`: list of built-in adapter names to skip (e.g.
     *   `["carbon-html-data"]`). Useful if a non-CEM file happens to match an
     *   adapter and you'd rather not surface it.
     */
    adapters: z
      .object({
        disable: z.array(z.string()).optional(),
      })
      .optional(),

    /**
     * Synonym map controls for paraphrastic search.
     * - `extend`: additional synonyms merged into the built-in map. Keys and
     *   values are lowercase single tokens. Pairs are bidirectional.
     * - `disable`: when true, the built-in map is dropped and only `extend`
     *   (if any) is used.
     */
    synonyms: z
      .object({
        extend: z.record(z.array(z.string())).optional(),
        disable: z.boolean().optional(),
      })
      .optional(),

    /**
     * Controls for `validate_component_usage`. Currently:
     * - `rules.disable`: list of rule IDs to skip
     *   (`unknown-tag`, `unknown-attr`, `invalid-value`, ...). See
     *   docs/adr-0005-extensibility.md.
     */
    validate: z
      .object({
        rules: z
          .object({
            disable: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();

export type CemConfig = z.infer<typeof ConfigSchema>;

const EMPTY_CONFIG: CemConfig = {};

export interface ResolvedConfig {
  config: CemConfig;
  sourcePath: string | null;
  /** Directory used to resolve relative paths in `paths`. */
  baseDir: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(
  projectRoot: string,
  explicitPath?: string,
): Promise<ResolvedConfig> {
  let path: string | null = null;
  if (explicitPath) {
    path = isAbsolute(explicitPath) ? explicitPath : resolve(projectRoot, explicitPath);
    if (!(await fileExists(path))) {
      throw new Error(`Config file not found: ${path}`);
    }
  } else {
    const candidate = resolve(projectRoot, "cem.config.json");
    if (await fileExists(candidate)) path = candidate;
  }

  if (!path) return { config: EMPTY_CONFIG, sourcePath: null, baseDir: projectRoot };

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${path}: ${parsed.error.message}`);
  }
  return { config: parsed.data, sourcePath: path, baseDir: resolve(path, "..") };
}

export function applyPackageFilter(
  names: string[],
  filter: CemConfig["packages"] | undefined,
): string[] {
  if (!filter) return names;
  const include = filter.include;
  const exclude = new Set(filter.exclude ?? []);
  return names.filter((n) => (include ? include.includes(n) : true)).filter((n) => !exclude.has(n));
}

// Extracts per-package entries from the `packages` map, stripping out the
// reserved `include`/`exclude` filter keys. Callers use this to look up
// path/overlay/etc. for a named package without worrying about the filter
// keys leaking through.
export function perPackageEntries(
  packages: CemConfig["packages"] | undefined,
): Map<string, PackageConfig> {
  const out = new Map<string, PackageConfig>();
  if (!packages) return out;
  for (const [k, v] of Object.entries(packages)) {
    if (k === "include" || k === "exclude") continue;
    out.set(k, v as PackageConfig);
  }
  return out;
}

// Returns the merged manifest-path map. Top-level `paths` and per-package
// `path` both feed in; per-package wins on conflict.
export function mergedPathOverrides(config: CemConfig): Record<string, string> {
  const out: Record<string, string> = { ...(config.paths ?? {}) };
  for (const [name, pkg] of perPackageEntries(config.packages)) {
    if (pkg.path) out[name] = pkg.path;
  }
  return out;
}
