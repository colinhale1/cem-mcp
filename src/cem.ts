import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  builtinAdapters,
  selectAdapters,
  findAdapter,
  type CemAdapter,
} from "./adapters/index.js";
import { buildBm25Index, scoreBm25, type Bm25Index } from "./bm25.js";
import { applyPackageFilter, loadConfig, type ResolvedConfig } from "./config.js";
import { buildIndex, fuzzySearchTags, type FuzzyMatch, type TagIndex } from "./fuzzy.js";
import { discoverPackages, type DiscoveredPackage } from "./discovery.js";
import { buildSynonymMap, expandQuery } from "./synonyms.js";
import { tokenize } from "./text.js";

// Minimal types covering the subset of CEM 2.x we read. The spec is open-ended,
// so anything we don't model is preserved via index signature.
export interface CemAttribute {
  name: string;
  description?: string;
  default?: string;
  fieldName?: string;
  type?: { text?: string };
}

export interface CemSlot {
  name: string;
  description?: string;
}

export interface CemEvent {
  name: string;
  description?: string;
  type?: { text?: string };
  cancelable?: boolean;
}

export interface CemCssProperty {
  name: string;
  description?: string;
  default?: string;
}

export interface CemCssPart {
  name: string;
  description?: string;
}

export interface CemMember {
  kind: "field" | "method";
  name: string;
  description?: string;
  privacy?: "public" | "private" | "protected";
  static?: boolean;
  type?: { text?: string };
  default?: string;
  parameters?: Array<{ name: string; description?: string; type?: { text?: string } }>;
  return?: { type?: { text?: string }; description?: string };
}

export interface CemDeclaration {
  kind: string;
  name: string;
  tagName?: string;
  customElement?: boolean;
  description?: string;
  summary?: string;
  attributes?: CemAttribute[];
  members?: CemMember[];
  events?: CemEvent[];
  slots?: CemSlot[];
  cssProperties?: CemCssProperty[];
  cssParts?: CemCssPart[];
  superclass?: { name?: string; package?: string };
  [k: string]: unknown;
}

export interface CemModule {
  kind: string;
  path: string;
  declarations?: CemDeclaration[];
  [k: string]: unknown;
}

export interface CustomElementsManifest {
  schemaVersion: string;
  modules: CemModule[];
  [k: string]: unknown;
}

export interface LoadedPackage {
  name: string;
  version?: string;
  cemPath: string;
  adapter: CemAdapter;
  manifest: CustomElementsManifest;
  elements: CemDeclaration[];
  byTag: Map<string, CemDeclaration>;
  index: TagIndex[]; // pre-built fuzzy index over tag names
  prefix: string; // common tag prefix (e.g. "calcite")
  bm25: Bm25Index; // pre-built BM25 index over component descriptions / attribute text
  synonyms: Map<string, string[]>; // bidirectional synonym map applied at query time
}

async function loadManifestThroughAdapter(
  cemPath: string,
  adapter: CemAdapter,
): Promise<CustomElementsManifest> {
  const raw = await readFile(cemPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!adapter.matches(parsed)) {
    throw new Error(
      `Adapter ${adapter.name} no longer matches ${cemPath} (file may have changed on disk).`,
    );
  }
  const manifest = adapter.load(parsed, cemPath);
  if (!manifest || !Array.isArray(manifest.modules)) {
    throw new Error(`Adapter ${adapter.name} produced an invalid manifest from ${cemPath}.`);
  }
  return manifest;
}

// HTML custom-element names must contain a hyphen and be ASCII-lowercase
// (per the HTML spec). Some packages publish CEMs where `tagName` points to
// the *symbol* of a constant holding the tag string (e.g. Vonage Vivid's
// `VC_HEX_PICKER_TAG`) — the build tool couldn't resolve the reference. We
// filter those out so the matcher only ever sees well-formed tags.
function isValidCustomElementTag(tag: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tag);
}

// Concatenate every searchable text field of a declaration into a single bag
// of tokens. We deliberately fold attribute / event / slot / CSS names into
// the same document as the descriptions — BM25's document-length
// normalization keeps verbose components from drowning out terse ones, and
// indexing names alongside descriptions means a query like "click" finds the
// component whose `click` event description matches.
function declarationText(decl: CemDeclaration): string {
  const parts: string[] = [];
  if (decl.tagName) parts.push(decl.tagName);
  if (decl.description) parts.push(decl.description);
  if (decl.summary) parts.push(decl.summary);
  for (const a of decl.attributes ?? []) {
    parts.push(a.name);
    if (a.description) parts.push(a.description);
  }
  for (const m of decl.members ?? []) {
    if (m.privacy === "private") continue;
    parts.push(m.name);
    if (m.description) parts.push(m.description);
  }
  for (const e of decl.events ?? []) {
    parts.push(e.name);
    if (e.description) parts.push(e.description);
  }
  for (const s of decl.slots ?? []) {
    if (s.name) parts.push(s.name);
    if (s.description) parts.push(s.description);
  }
  for (const c of decl.cssProperties ?? []) {
    parts.push(c.name);
    if (c.description) parts.push(c.description);
  }
  for (const c of decl.cssParts ?? []) {
    parts.push(c.name);
    if (c.description) parts.push(c.description);
  }
  return parts.join(" ");
}

function indexManifest(
  meta: { name: string; version?: string; cemPath: string; adapter: CemAdapter },
  manifest: CustomElementsManifest,
  synonyms: Map<string, string[]>,
): LoadedPackage {
  const elements: CemDeclaration[] = [];
  const byTag = new Map<string, CemDeclaration>();
  for (const mod of manifest.modules) {
    for (const decl of mod.declarations ?? []) {
      if (!decl.tagName) continue;
      if (!isValidCustomElementTag(decl.tagName)) continue;
      elements.push(decl);
      byTag.set(decl.tagName.toLowerCase(), decl);
    }
  }
  const { index, prefix } = buildIndex(elements);

  // Build the BM25 corpus once. Each component becomes a single document
  // keyed by its lowercased tag name so we can join scores back during search.
  const docs = new Map<string, string[]>();
  for (const decl of elements) {
    docs.set(decl.tagName!.toLowerCase(), tokenize(declarationText(decl)));
  }
  const bm25 = buildBm25Index(docs);

  return { ...meta, manifest, elements, byTag, index, prefix, bm25, synonyms };
}

export interface RegistryOptions {
  /** Optional explicit config path. If omitted, looks for cem.config.json in the project root. */
  configPath?: string;
}

export class CemRegistry {
  private readonly packages = new Map<string, LoadedPackage>();
  private readonly known = new Map<string, DiscoveredPackage>();
  readonly projectRoot: string | null;
  readonly config: ResolvedConfig;
  readonly adapters: ReadonlyArray<CemAdapter>;

  private constructor(
    projectRoot: string | null,
    config: ResolvedConfig,
    adapters: ReadonlyArray<CemAdapter>,
    synonyms: Map<string, string[]>,
  ) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.adapters = adapters;
    this.synonyms = synonyms;
  }

  private readonly synonyms: Map<string, string[]>;

  static async fromProject(
    projectRoot: string,
    options: RegistryOptions = {},
  ): Promise<CemRegistry> {
    const root = resolve(projectRoot);
    const config = await loadConfig(root, options.configPath);
    const adapters = selectAdapters(builtinAdapters, config.config.adapters?.disable);
    const synonyms = buildSynonymMap(
      undefined,
      config.config.synonyms?.extend,
      config.config.synonyms?.disable === true,
    );
    const reg = new CemRegistry(root, config, adapters, synonyms);

    // Discovery (auto from node_modules).
    const discovered = await discoverPackages(root, adapters);
    for (const d of discovered) reg.known.set(d.name, d);

    // Manual path overrides from config — added in addition to discovered, win on
    // name conflict because the user explicitly asked for them.
    const manualPaths = config.config.paths ?? {};
    for (const [name, relPath] of Object.entries(manualPaths)) {
      const abs = resolve(config.baseDir, relPath);
      // Determine adapter eagerly so a misconfigured path fails fast at startup.
      const raw = await readFile(abs, "utf8").catch(() => null);
      if (raw == null) {
        throw new Error(`Config path for '${name}' not found: ${abs}`);
      }
      const parsed = JSON.parse(raw);
      const adapter = findAdapter(adapters, parsed);
      if (!adapter) {
        throw new Error(
          `Config path for '${name}' (${abs}) does not match any known adapter (${adapters
            .map((a) => a.name)
            .join(", ")}).`,
        );
      }
      reg.known.set(name, {
        name,
        version: undefined,
        packageDir: "",
        cemPath: abs,
        adapter,
      });
    }

    // Apply include/exclude filtering.
    const allowed = new Set(
      applyPackageFilter(Array.from(reg.known.keys()), config.config.packages),
    );
    for (const k of Array.from(reg.known.keys())) {
      if (!allowed.has(k)) reg.known.delete(k);
    }

    return reg;
  }

  packageNames(): string[] {
    return Array.from(this.known.keys()).sort();
  }

  packagesMeta(): DiscoveredPackage[] {
    return Array.from(this.known.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.known.has(name);
  }

  // Lazy load — only parse a package's CEM the first time it's asked for.
  async get(name: string): Promise<LoadedPackage> {
    const cached = this.packages.get(name);
    if (cached) return cached;
    const meta = this.known.get(name);
    if (!meta) {
      throw new Error(
        `Unknown package '${name}'. Available: ${this.packageNames().join(", ") || "(none)"}`,
      );
    }
    const manifest = await loadManifestThroughAdapter(meta.cemPath, meta.adapter);
    const loaded = indexManifest(meta, manifest, this.synonyms);
    this.packages.set(name, loaded);
    return loaded;
  }
}

export interface SearchHit {
  decl: CemDeclaration;
  score: number;
  reasons: string[];
}

// Tunables for combining the fuzzy tag score with the BM25 text score.
// BM25 scores are scaled and capped so that text relevance can rescue a
// no-tag-match query but cannot, on its own, exceed the definitive-hit
// promotion threshold (400). A paraphrastic match should produce a ranked
// list, not a confident full-doc response.
const BM25_WEIGHT = 30;
const BM25_CAP = 300;

// Combine the pre-built tag-fuzzy index with BM25 over a per-component text
// corpus. Anchored queries (containing tag fragments) are dominated by the
// fuzzy score; paraphrastic queries (intent without tag fragments) ride on
// BM25. The synonym map closes the lexical gap for common UI paraphrases
// ("toast" → "alert", "spinner" → "loader") before BM25 ever sees the query.
export function searchElements(pkg: LoadedPackage, query: string, limit = 20): SearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const tagHits = fuzzySearchTags(pkg.index, q, pkg.elements.length);
  const byTag = new Map<string, FuzzyMatch>();
  for (const h of tagHits) byTag.set(h.decl.tagName!.toLowerCase(), h);

  const tokens = tokenize(q);
  const expanded = expandQuery(tokens, pkg.synonyms);
  const bm25Raw = scoreBm25(pkg.bm25, expanded);

  const hits: SearchHit[] = [];
  for (const decl of pkg.elements) {
    const tag = decl.tagName!.toLowerCase();
    const tagMatch = byTag.get(tag);
    let score = tagMatch?.score ?? 0;
    const reasons: string[] = tagMatch ? [...tagMatch.reasons] : [];

    const raw = bm25Raw.get(tag) ?? 0;
    if (raw > 0) {
      const scaled = Math.min(BM25_CAP, raw * BM25_WEIGHT);
      score += scaled;
      reasons.push(`text relevance ${raw.toFixed(2)}`);
    }

    if (score > 0) hits.push({ decl, score, reasons });
  }

  hits.sort((a, b) => b.score - a.score || a.decl.tagName!.localeCompare(b.decl.tagName!));
  return hits.slice(0, limit);
}
