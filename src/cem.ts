import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildIndex, fuzzySearchTags, type FuzzyMatch, type TagIndex } from "./fuzzy.js";
import { discoverPackages, type DiscoveredPackage } from "./discovery.js";

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
  manifest: CustomElementsManifest;
  elements: CemDeclaration[];
  byTag: Map<string, CemDeclaration>;
  index: TagIndex[]; // pre-built fuzzy index over tag names
  prefix: string; // common tag prefix (e.g. "calcite")
}

async function loadManifest(cemPath: string): Promise<CustomElementsManifest> {
  const raw = await readFile(cemPath, "utf8");
  const parsed = JSON.parse(raw) as CustomElementsManifest;
  if (!parsed || !Array.isArray(parsed.modules)) {
    throw new Error(`Not a valid Custom Elements Manifest: ${cemPath}`);
  }
  return parsed;
}

// HTML custom-element names must contain a hyphen and be ASCII-lowercase
// (per the HTML spec). Some packages publish CEMs where `tagName` points to
// the *symbol* of a constant holding the tag string (e.g. Vonage Vivid's
// `VC_HEX_PICKER_TAG`) — the build tool couldn't resolve the reference. We
// filter those out so the matcher only ever sees well-formed tags.
function isValidCustomElementTag(tag: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tag);
}

function indexManifest(
  meta: { name: string; version?: string; cemPath: string },
  manifest: CustomElementsManifest,
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
  return { ...meta, manifest, elements, byTag, index, prefix };
}

export class CemRegistry {
  private readonly packages = new Map<string, LoadedPackage>();
  private readonly known = new Map<string, DiscoveredPackage>();
  readonly projectRoot: string | null;

  constructor(projectRoot: string | null) {
    this.projectRoot = projectRoot;
  }

  static async fromProject(projectRoot: string): Promise<CemRegistry> {
    const reg = new CemRegistry(resolve(projectRoot));
    const discovered = await discoverPackages(reg.projectRoot!);
    for (const d of discovered) reg.known.set(d.name, d);
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
    const manifest = await loadManifest(meta.cemPath);
    const loaded = indexManifest(meta, manifest);
    this.packages.set(name, loaded);
    return loaded;
  }

  // Test/script helper: register a package manually (skipping discovery).
  registerManual(name: string, cemPath: string, version?: string): void {
    this.known.set(name, { name, version, packageDir: "", cemPath: resolve(cemPath) });
  }
}

export interface SearchHit {
  decl: CemDeclaration;
  score: number;
  reasons: string[];
}

// Fuzzy-search a package. Combines the pre-indexed tag matcher with substring
// scoring over description / attributes / events / slots / CSS vars so a query
// like "color" still surfaces components whose tag doesn't include the word but
// whose docs do.
export function searchElements(pkg: LoadedPackage, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tagHits = fuzzySearchTags(pkg.index, query, pkg.elements.length);
  const byTag = new Map<string, FuzzyMatch>();
  for (const h of tagHits) byTag.set(h.decl.tagName!.toLowerCase(), h);

  const tokens = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const decl of pkg.elements) {
    const tag = decl.tagName!.toLowerCase();
    const summary = (decl.summary ?? decl.description ?? "").toLowerCase();
    const tagMatch = byTag.get(tag);
    let score = tagMatch?.score ?? 0;
    const reasons: string[] = tagMatch ? [...tagMatch.reasons] : [];

    for (const t of tokens) {
      if (summary.includes(t)) {
        score += 5;
        reasons.push(`desc contains: ${t}`);
      }
      const attrHit = decl.attributes?.find((a) => a.name.toLowerCase().includes(t));
      if (attrHit) {
        score += 4;
        reasons.push(`attribute: ${attrHit.name}`);
      }
      const slotHit = decl.slots?.find((s) => (s.name || "(default)").toLowerCase().includes(t));
      if (slotHit) {
        score += 3;
        reasons.push(`slot: ${slotHit.name || "(default)"}`);
      }
      const eventHit = decl.events?.find((e) => e.name.toLowerCase().includes(t));
      if (eventHit) {
        score += 4;
        reasons.push(`event: ${eventHit.name}`);
      }
      const cssVarHit = decl.cssProperties?.find((c) => c.name.toLowerCase().includes(t));
      if (cssVarHit) {
        score += 2;
        reasons.push(`css var: ${cssVarHit.name}`);
      }
      const partHit = decl.cssParts?.find((p) => p.name.toLowerCase().includes(t));
      if (partHit) {
        score += 2;
        reasons.push(`css part: ${partHit.name}`);
      }
    }

    if (score > 0) hits.push({ decl, score, reasons });
  }

  hits.sort((a, b) => b.score - a.score || a.decl.tagName!.localeCompare(b.decl.tagName!));
  return hits.slice(0, limit);
}
