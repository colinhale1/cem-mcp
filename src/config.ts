import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";

// User-editable configuration. Optional — sensible defaults take over when no
// file is found. Discovery looks for `cem.config.json` in the project root by
// default, or wherever `--config <path>` points.

const ConfigSchema = z
  .object({
    /**
     * Override which packages discovery is allowed to register.
     * - `include`: if set, ONLY these packages are registered (allow-list).
     * - `exclude`: packages to drop from discovery (deny-list).
     */
    packages: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .optional(),

    /**
     * Manual package → manifest path mapping. Paths are resolved relative to
     * the config file's directory. Use this for CEMs that live outside
     * `node_modules` (vendored builds, monorepo siblings, etc.). Manual
     * entries are added in addition to discovered ones; the manual path wins
     * if a package is both discovered and manually registered.
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
    throw new Error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
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
  return names
    .filter((n) => (include ? include.includes(n) : true))
    .filter((n) => !exclude.has(n));
}
