import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { builtinAdapters, selectAdapters, findAdapter, type CemAdapter } from "./adapters/index.js";
import { buildBm25Index, scoreBm25, type Bm25Index } from "./bm25.js";
import {
  applyPackageFilter,
  loadConfig,
  mergedPathOverrides,
  perPackageEntries,
  type ResolvedConfig,
} from "./config.js";
import { applyOverlay, loadOverlay } from "./overlay.js";
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
  // Optional augmentation supplied by a per-package overlay file. Populated
  // post-load by applyOverlay(); never present in upstream CEM data.
  // See docs/adr-0005-extensibility.md.
  overlay?: import("./overlay.js").OverlayElement;
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
  // attrIndex: attribute name → tags that declare that attribute. Used to
  // detect attribute-anchored queries like "scale s m l".
  attrIndex: Map<string, Set<string>>;
  // attrValuesByTag: tag → attribute name → set of declared values (extracted
  // from type.text and type.values). Lets attribute-anchored queries score
  // by value-coverage ("scale" + "s|m|l" → strong match for components whose
  // scale attribute accepts s/m/l).
  attrValuesByTag: Map<string, Map<string, Set<string>>>;
  // tagTokenIndex: kebab token (e.g. "accordion") → tags that contain it.
  // Used for the synonym-to-tag boost — when a synonym expansion lands on a
  // token that names a component fragment, that component should win even if
  // its description text is empty.
  tagTokenIndex: Map<string, Set<string>>;
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

// Pull a flat list of value tokens from an attribute declaration. Values
// appear either in `type.text` as a union of quoted strings
// (`"s" | "m" | "l"`) or as a structured `type.values` array. We keep them
// lowercased and unfiltered so single-char tokens like "s", "m", "l" survive
// for attribute-value matching.
function attributeValues(a: CemAttribute): string[] {
  const out = new Set<string>();
  if (a.type?.text) {
    for (const m of a.type.text.matchAll(/"([^"]+)"/g)) out.add(m[1].toLowerCase());
  }
  const structured = (a as { type?: { values?: Array<{ value?: unknown }> } }).type?.values;
  if (Array.isArray(structured)) {
    for (const v of structured) {
      if (v && typeof v.value === "string") out.add(v.value.toLowerCase());
    }
  }
  return Array.from(out);
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

  // Attribute name → tags that declare it; per-tag attribute → value-set.
  const attrIndex = new Map<string, Set<string>>();
  const attrValuesByTag = new Map<string, Map<string, Set<string>>>();
  for (const decl of elements) {
    const tag = decl.tagName!.toLowerCase();
    for (const a of decl.attributes ?? []) {
      const name = a.name.toLowerCase();
      let tags = attrIndex.get(name);
      if (!tags) {
        tags = new Set();
        attrIndex.set(name, tags);
      }
      tags.add(tag);
      let perTag = attrValuesByTag.get(tag);
      if (!perTag) {
        perTag = new Map();
        attrValuesByTag.set(tag, perTag);
      }
      perTag.set(name, new Set(attributeValues(a)));
    }
  }

  // Reverse index of kebab tag tokens → tags. "accordion" → {calcite-accordion,
  // calcite-accordion-item}. Lets us boost components when a query synonym
  // resolves to a token that names a component.
  const tagTokenIndex = new Map<string, Set<string>>();
  for (const decl of elements) {
    const tag = decl.tagName!.toLowerCase();
    for (const token of tag.split("-")) {
      if (!token) continue;
      let tags = tagTokenIndex.get(token);
      if (!tags) {
        tags = new Set();
        tagTokenIndex.set(token, tags);
      }
      tags.add(tag);
    }
  }

  return {
    ...meta,
    manifest,
    elements,
    byTag,
    index,
    prefix,
    bm25,
    synonyms,
    attrIndex,
    attrValuesByTag,
    tagTokenIndex,
  };
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
    // name conflict because the user explicitly asked for them. Merges top-level
    // `paths` and per-package `packages.<name>.path` into one map.
    const manualPaths = mergedPathOverrides(config.config);
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
    await this.maybeApplyOverlay(loaded);
    this.packages.set(name, loaded);
    return loaded;
  }

  private async maybeApplyOverlay(loaded: LoadedPackage): Promise<void> {
    const pkgEntry = perPackageEntries(this.config.config.packages).get(loaded.name);
    if (!pkgEntry?.overlay) return;
    try {
      const { document } = await loadOverlay(pkgEntry.overlay, this.config.baseDir);
      const result = applyOverlay(loaded, document);
      // Surface overlay drift on stderr; a tag in the overlay that doesn't
      // match a real CEM declaration usually means an upstream rename.
      if (result.unmatched.length) {
        process.stderr.write(
          `cem-mcp: overlay for ${loaded.name} references unknown tags: ${result.unmatched.join(", ")}\n`,
        );
      }
    } catch (err) {
      // Overlay errors don't block the package — log and continue with
      // upstream CEM data only.
      process.stderr.write(
        `cem-mcp: failed to load overlay for ${loaded.name}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
}

export interface SearchHit {
  decl: CemDeclaration;
  score: number;
  reasons: string[];
}

// Tunables for combining scoring channels. BM25 is capped below the 400-point
// definitive-promotion threshold so paraphrastic matches return a ranked list
// rather than a confident full-doc. The synonym-to-tag boost applies a fixed
// per-tag bonus when a synonym expansion lands on a known kebab token (e.g.
// "expandable" → "accordion" → calcite-accordion). Attribute-anchored scoring
// runs as a separate channel triggered only when the query head is a known
// attribute name with multiple candidates.
const BM25_WEIGHT = 30;
const BM25_CAP = 300;
const TOKEN_TO_TAG_BOOST = 150; // per token, scaled by token weight (originals=1.0, synonyms=0.6)
const TOKEN_TO_TAG_CAP = 300; // total boost cap per tag, to keep multi-token-match components from runaway
const ATTRIBUTE_ANCHORED_BASE = 80;
const ATTRIBUTE_ANCHORED_VALUE_BONUS = 120; // per full coverage

// When the head token of a query is an attribute name shared by >=2 components,
// treat the query as a category lookup ("which components have this attribute,
// optionally with these values"). Returns per-tag scores to add to the main
// hits map. Empty when the query doesn't look attribute-anchored.
function attributeAnchoredScores(
  pkg: LoadedPackage,
  rawQuery: string,
): Map<string, { score: number; reason: string }> {
  const out = new Map<string, { score: number; reason: string }>();
  // We don't go through tokenize() here because we want to preserve
  // single-character value tokens like "s", "m", "l" that the standard
  // tokenizer drops.
  const raw = rawQuery
    .toLowerCase()
    .split(/[\s,|/]+/)
    .filter(Boolean);
  if (raw.length === 0) return out;

  const head = raw[0];
  const tagsWithAttr = pkg.attrIndex.get(head);
  if (!tagsWithAttr || tagsWithAttr.size < 2) return out;

  const valueTokens = raw.slice(1);
  for (const tag of tagsWithAttr) {
    const values = pkg.attrValuesByTag.get(tag)?.get(head) ?? new Set();
    let matched = 0;
    for (const vt of valueTokens) if (values.has(vt)) matched++;
    const coverage = valueTokens.length > 0 ? matched / valueTokens.length : 0;
    const score = ATTRIBUTE_ANCHORED_BASE + Math.round(ATTRIBUTE_ANCHORED_VALUE_BONUS * coverage);
    const reason =
      valueTokens.length === 0
        ? `attribute '${head}' declared`
        : `attribute '${head}' (${matched}/${valueTokens.length} values match)`;
    out.set(tag, { score, reason });
  }
  return out;
}

// When a synonym expansion produces a token that names a known component
// fragment (e.g. "expandable" → "accordion", and `accordion` is a kebab token
// in `calcite-accordion`), boost that component. This fixes cases where the
// target component has an empty description and the only place its name lives
// is in the tag itself.
function tokenToTagBoosts(
  pkg: LoadedPackage,
  expanded: Array<{ term: string; weight: number }>,
): Map<string, { score: number; reasons: string[] }> {
  const out = new Map<string, { score: number; reasons: string[] }>();
  for (const { term, weight } of expanded) {
    const tags = pkg.tagTokenIndex.get(term);
    if (!tags) continue;
    const lift = Math.round(TOKEN_TO_TAG_BOOST * weight);
    for (const tag of tags) {
      let bucket = out.get(tag);
      if (!bucket) {
        bucket = { score: 0, reasons: [] };
        out.set(tag, bucket);
      }
      bucket.score = Math.min(TOKEN_TO_TAG_CAP, bucket.score + lift);
      bucket.reasons.push(
        weight === 1 ? `token '${term}' matches tag` : `synonym '${term}' matches tag`,
      );
    }
  }
  return out;
}

// Combine the pre-built tag-fuzzy index, BM25 over a per-component text
// corpus, an attribute-anchored channel, and a synonym-to-tag boost. Anchored
// queries (containing tag fragments) are dominated by the fuzzy score;
// paraphrastic queries (intent without tag fragments) ride on BM25 plus the
// synonym map plus the synonym-to-tag boost; attribute-anchored queries
// (head token names an attribute, rest are candidate values) get their own
// per-tag bonus and naturally produce a category list.
export function searchElements(pkg: LoadedPackage, query: string, limit = 20): SearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const tagHits = fuzzySearchTags(pkg.index, q, pkg.elements.length);
  const byTag = new Map<string, FuzzyMatch>();
  for (const h of tagHits) byTag.set(h.decl.tagName!.toLowerCase(), h);

  const tokens = tokenize(q);
  const expanded = expandQuery(tokens, pkg.synonyms);
  const bm25Raw = scoreBm25(pkg.bm25, expanded);

  const attrHits = attributeAnchoredScores(pkg, q);
  const tagBoosts = tokenToTagBoosts(pkg, expanded);

  const hits: SearchHit[] = [];
  for (const decl of pkg.elements) {
    const tag = decl.tagName!.toLowerCase();
    const tagMatch = byTag.get(tag);
    let score = tagMatch?.score ?? 0;
    const reasons: string[] = tagMatch ? [...tagMatch.reasons] : [];

    const attrBoost = attrHits.get(tag);
    const raw = bm25Raw.get(tag) ?? 0;

    // When attribute-anchored fires for this component, the query is a
    // category lookup. BM25 just contributes noise (favoring components whose
    // description happens to use the attribute name more) and breaks the
    // intended tie across all matching components. Tag fuzzy + the attribute
    // boost are the right signal; let alphabetical settle the rest.
    if (raw > 0 && !attrBoost) {
      const scaled = Math.min(BM25_CAP, raw * BM25_WEIGHT);
      score += scaled;
      reasons.push(`text relevance ${raw.toFixed(2)}`);
    }

    const tagBoost = tagBoosts.get(tag);
    if (tagBoost) {
      score += tagBoost.score;
      reasons.push(...tagBoost.reasons);
    }

    if (attrBoost) {
      score += attrBoost.score;
      reasons.push(attrBoost.reason);
    }

    if (score > 0) hits.push({ decl, score, reasons });
  }

  hits.sort((a, b) => b.score - a.score || a.decl.tagName!.localeCompare(b.decl.tagName!));
  return hits.slice(0, limit);
}
