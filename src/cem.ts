import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

export interface LoadedCem {
  manifest: CustomElementsManifest;
  elements: CemDeclaration[]; // declarations with a tagName
  byTag: Map<string, CemDeclaration>;
  sourcePath: string;
}

export async function loadCem(path: string): Promise<LoadedCem> {
  const absolute = resolve(path);
  const raw = await readFile(absolute, "utf8");
  const manifest = JSON.parse(raw) as CustomElementsManifest;

  if (!manifest || !Array.isArray(manifest.modules)) {
    throw new Error(`File at ${absolute} is not a valid Custom Elements Manifest (missing modules array).`);
  }

  const elements: CemDeclaration[] = [];
  const byTag = new Map<string, CemDeclaration>();
  for (const mod of manifest.modules) {
    for (const decl of mod.declarations ?? []) {
      if (decl.tagName) {
        elements.push(decl);
        byTag.set(decl.tagName.toLowerCase(), decl);
      }
    }
  }

  return { manifest, elements, byTag, sourcePath: absolute };
}

export interface SearchHit {
  decl: CemDeclaration;
  score: number;
  reasons: string[];
}

// Score-based substring search across the fields that matter for LLM lookup:
// tag name, summary/description, attributes, slots, events, CSS properties/parts.
export function searchElements(cem: LoadedCem, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tokens = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const decl of cem.elements) {
    const tag = (decl.tagName ?? "").toLowerCase();
    const summary = (decl.summary ?? decl.description ?? "").toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    for (const t of tokens) {
      if (tag === t) {
        score += 100;
        reasons.push(`tag exact: ${t}`);
      } else if (tag.includes(t)) {
        score += 30;
        reasons.push(`tag contains: ${t}`);
      }
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

  hits.sort((a, b) => b.score - a.score || (a.decl.tagName ?? "").localeCompare(b.decl.tagName ?? ""));
  return hits.slice(0, limit);
}
