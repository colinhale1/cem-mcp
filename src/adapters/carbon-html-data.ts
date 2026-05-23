import type { CemAttribute, CemDeclaration, CustomElementsManifest } from "../cem.js";
import type { CemAdapter } from "./types.js";

// VS Code HTML custom-data v1.1, as shipped by @carbon/web-components at
// `custom-elements.json`. Same filename as a real CEM, completely different
// schema: `{ version, tags: [{ name, description, attributes: [{ name, type,
// description, values? }] }] }`. We map it to a minimal CEM 2.x manifest so
// the rest of the pipeline can treat it uniformly.
//
// Limitations: HTML custom-data has no concept of events, slots, methods,
// properties (vs attributes), CSS parts, or CSS custom properties — so we
// surface what's there (tag + attributes) and the consumer just sees fewer
// sections. That's better than skipping the library entirely.

interface CarbonAttribute {
  name: string;
  description?: string;
  type?: string;
  default?: string;
  values?: Array<{ name: string }>;
}

interface CarbonTag {
  name: string;
  path?: string;
  description?: string;
  attributes?: CarbonAttribute[];
}

interface CarbonData {
  version: string;
  tags?: CarbonTag[];
}

function toPascal(tag: string): string {
  return tag
    .split("-")
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join("");
}

function attrType(a: CarbonAttribute): { text: string } | undefined {
  if (a.values && a.values.length) {
    return { text: a.values.map((v) => `"${v.name}"`).join(" | ") };
  }
  if (a.type) return { text: a.type };
  return undefined;
}

export const carbonHtmlDataAdapter: CemAdapter = {
  name: "carbon-html-data",
  matches(parsed): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const o = parsed as { version?: unknown; tags?: unknown; modules?: unknown };
    // Be conservative: a file with both `modules` and `tags` should be claimed
    // by the cem2 adapter (which ships first), not this one.
    if (Array.isArray(o.modules)) return false;
    return typeof o.version === "string" && Array.isArray(o.tags);
  },
  load(parsed, sourcePath): CustomElementsManifest {
    const data = parsed as CarbonData;
    const declarations: CemDeclaration[] = (data.tags ?? []).map((tag) => ({
      kind: "class",
      name: toPascal(tag.name),
      tagName: tag.name,
      customElement: true,
      description: tag.description,
      attributes: (tag.attributes ?? []).map<CemAttribute>((a) => ({
        name: a.name,
        description: a.description,
        default: a.default,
        type: attrType(a),
      })),
    }));
    return {
      schemaVersion: "2.1.0",
      modules: [{ kind: "javascript-module", path: sourcePath, declarations }],
    };
  },
};
