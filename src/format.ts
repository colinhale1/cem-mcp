import type { DiscoveredPackage } from "./discovery.js";
import type { CemAttribute, CemDeclaration, CemEvent, LoadedPackage, SearchHit } from "./cem.js";

const firstLine = (s: string | undefined): string => (s ?? "").split(/\r?\n/)[0]?.trim() ?? "";

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

// Aspect vocabulary — kept in lockstep with the schema in src/index.ts. Section
// names in compact and drilled output use these exact strings so the agent
// learns one set of identifiers and can target them without re-reading prior
// output. See docs/adr-0002-tool-shape.md.
export const ASPECTS = ["attrs", "events", "slots", "css", "methods", "examples", "all"] as const;
export type Aspect = (typeof ASPECTS)[number];

export function formatPackageList(
  packages: DiscoveredPackage[],
  projectRoot: string | null,
  configPath: string | null = null,
): string {
  const lines: string[] = [];
  lines.push(`# Available packages (${packages.length})`);
  if (projectRoot) lines.push(`Project: \`${projectRoot}\``);
  if (configPath) lines.push(`Config: \`${configPath}\``);
  lines.push("");
  if (packages.length === 0) {
    lines.push("_No packages with a Custom Elements Manifest found._");
    lines.push("");
    lines.push("Things to check:");
    lines.push(
      "- Is `node_modules` populated in the project root? Discovery scans `<project>/node_modules`.",
    );
    lines.push("- Does the project actually depend on a web-components library?");
    lines.push(
      "  Examples that ship a CEM the server can read: `@esri/calcite-components`, " +
        "`@shoelace-style/shoelace`, `@patternfly/elements`, `@rhds/elements`, " +
        "`@nordhealth/components`, `@ui5/webcomponents`, `@carbon/web-components`, `@cds/core`.",
    );
    lines.push(
      "- If you have a CEM at a path outside `node_modules`, register it via `cem.config.json`:",
    );
    lines.push("  ```json");
    lines.push('  { "paths": { "@my/lib": "./vendor/my-lib/custom-elements.json" } }');
    lines.push("  ```");
    return lines.join("\n");
  }
  for (const p of packages) {
    const v = p.version ? `@${p.version}` : "";
    const adapter = p.adapter.name === "cem2" ? "" : ` _via ${p.adapter.name}_`;
    lines.push(`- \`${p.name}${v}\`${adapter}`);
  }
  return lines.join("\n");
}

export function formatComponentList(pkg: LoadedPackage): string {
  const lines: string[] = [];
  const v = pkg.version ? `@${pkg.version}` : "";
  lines.push(`# \`${pkg.name}${v}\` — ${pkg.elements.length} components`);
  lines.push(`Source: \`${pkg.cemPath}\` · schema ${pkg.manifest.schemaVersion}`);
  lines.push("");
  const sorted = [...pkg.elements].sort((a, b) => (a.tagName ?? "").localeCompare(b.tagName ?? ""));
  for (const decl of sorted) {
    const summary = firstLine(decl.summary ?? decl.description);
    lines.push(`- \`${decl.tagName}\`${summary ? ` — ${truncate(summary, 140)}` : ""}`);
  }
  return lines.join("\n");
}

// Compact view — the default shape for an exact-tag lookup. Names without
// types/defaults/descriptions; section names match aspect vocabulary 1:1;
// counts in parentheses are locators the agent uses to decide what to drill
// into. Zero-count sections are omitted entirely. See ADR-0002.
export function formatElementCompact(decl: CemDeclaration, packageName?: string): string {
  const lines: string[] = [];
  lines.push(`# \`${decl.tagName}\`${packageName ? ` _(${packageName})_` : ""}`);
  if (decl.name && decl.name !== decl.tagName) lines.push(`Class: \`${decl.name}\``);
  if (decl.superclass?.name) lines.push(`Extends: \`${decl.superclass.name}\``);

  const desc = firstLine(decl.description ?? decl.summary);
  if (desc) {
    lines.push("");
    lines.push(truncate(desc, 200));
  }
  lines.push("");

  const attrs = decl.attributes ?? [];
  const events = decl.events ?? [];
  const slots = decl.slots ?? [];
  const methods = (decl.members ?? []).filter(
    (m) => m.kind === "method" && m.privacy !== "private",
  );
  const cssVars = decl.cssProperties ?? [];
  const cssParts = decl.cssParts ?? [];
  const examples = extractExamples(decl);

  if (attrs.length) {
    lines.push(`attrs (${attrs.length}): ${attrs.map((a) => a.name).join(", ")}`);
  }
  if (events.length) {
    lines.push(`events (${events.length}): ${events.map((e) => e.name).join(", ")}`);
  }
  if (slots.length) {
    lines.push(
      `slots (${slots.length}): ${slots.map((s) => (s.name ? s.name : "(default)")).join(", ")}`,
    );
  }
  if (methods.length) {
    lines.push(`methods (${methods.length}): ${methods.map((m) => m.name).join(", ")}`);
  }
  // css groups var declarations + shadow parts — they're rarely useful on their
  // own and pairing them keeps the aspect surface to seven slots, not eight.
  if (cssVars.length || cssParts.length) {
    const parts: string[] = [];
    if (cssVars.length) parts.push(`${cssVars.length} vars`);
    if (cssParts.length) parts.push(`${cssParts.length} parts`);
    lines.push(`css: ${parts.join(", ")}`);
  }
  if (examples.length) {
    lines.push(`examples: ${examples.length}`);
  }

  return lines.join("\n").trimEnd();
}

// "Give me everything" — the legacy eager output, kept available via
// `aspect: 'all'` for agents that genuinely need the full surface in one call.
export function formatElementFull(decl: CemDeclaration, packageName?: string): string {
  const lines: string[] = [];
  lines.push(`# \`${decl.tagName}\`${packageName ? ` _(${packageName})_` : ""}`);
  if (decl.name && decl.name !== decl.tagName) lines.push(`Class: \`${decl.name}\``);
  if (decl.superclass?.name) lines.push(`Extends: \`${decl.superclass.name}\``);
  lines.push("");
  if (decl.description) {
    lines.push(decl.description.trim());
    lines.push("");
  } else if (decl.summary) {
    lines.push(decl.summary.trim());
    lines.push("");
  }
  appendAttrs(lines, decl.attributes ?? []);
  appendProperties(lines, decl);
  appendMethods(lines, decl);
  appendEvents(lines, decl.events ?? []);
  appendSlots(lines, decl.slots ?? []);
  appendCss(lines, decl.cssProperties ?? [], decl.cssParts ?? []);
  appendExamples(lines, extractExamples(decl));
  return lines.join("\n").trimEnd();
}

export function formatAspect(decl: CemDeclaration, aspect: Aspect, packageName?: string): string {
  if (aspect === "all") return formatElementFull(decl, packageName);
  const lines: string[] = [];
  lines.push(`# \`${decl.tagName}\` — ${aspect}${packageName ? ` _(${packageName})_` : ""}`);
  lines.push("");
  switch (aspect) {
    case "attrs":
      appendAttrs(lines, decl.attributes ?? [], /*heading*/ false);
      break;
    case "events":
      appendEvents(lines, decl.events ?? [], /*heading*/ false);
      break;
    case "slots":
      appendSlots(lines, decl.slots ?? [], /*heading*/ false);
      break;
    case "methods":
      appendMethods(lines, decl, /*heading*/ false);
      break;
    case "css":
      appendCss(lines, decl.cssProperties ?? [], decl.cssParts ?? [], /*heading*/ false);
      break;
    case "examples":
      appendExamples(lines, extractExamples(decl), /*heading*/ false);
      break;
  }
  const trimmed = lines.join("\n").trimEnd();
  // If the section was empty, render that explicitly rather than returning a
  // bare heading; agents handle "(none)" better than blank.
  return /\n\s*$/.test(trimmed) || trimmed.split("\n").length <= 2 ? `${trimmed}\n(none)` : trimmed;
}

export function formatAttribute(
  decl: CemDeclaration,
  attrName: string,
  packageName?: string,
): string | null {
  const attr = (decl.attributes ?? []).find((a) => a.name === attrName);
  if (!attr) return null;
  const lines: string[] = [];
  lines.push(`# \`${decl.tagName}.${attr.name}\`${packageName ? ` _(${packageName})_` : ""}`);
  if (attr.type?.text) lines.push(`Type: \`${attr.type.text}\``);
  if (attr.default !== undefined) lines.push(`Default: \`${attr.default}\``);
  if (attr.fieldName && attr.fieldName !== attr.name) lines.push(`Property: \`${attr.fieldName}\``);
  if (attr.description) {
    lines.push("");
    lines.push(attr.description.trim());
  }
  return lines.join("\n");
}

export function formatEventDetail(
  decl: CemDeclaration,
  eventName: string,
  packageName?: string,
): string | null {
  const ev = (decl.events ?? []).find((e) => e.name === eventName);
  if (!ev) return null;
  const lines: string[] = [];
  lines.push(`# \`${decl.tagName}.${ev.name}\`${packageName ? ` _(${packageName})_` : ""}`);
  if (ev.type?.text) lines.push(`Type: \`${ev.type.text}\``);
  if (ev.cancelable) lines.push("Cancelable: yes");
  if (ev.description) {
    lines.push("");
    lines.push(ev.description.trim());
  }
  return lines.join("\n");
}

export interface MultiSection {
  query: string;
  body: string;
}

export function formatMulti(packageName: string, sections: MultiSection[]): string {
  const lines: string[] = [];
  lines.push(`# Multi-query: \`${packageName}\` (${sections.length})`);
  lines.push(`Queries: ${sections.map((s) => `\`${s.query}\``).join(", ")}`);
  lines.push("");
  sections.forEach((s, i) => {
    if (i > 0) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    lines.push(`=== Result for: \`${s.query}\` ===`);
    lines.push("");
    lines.push(s.body);
  });
  return lines.join("\n");
}

// Within-package ranked search. A confidence floor (see CROSS_PKG_FLOOR in
// cross-package search) is enforced upstream; here we just render whatever
// hits the caller passed in.
export function formatSearch(packageName: string, query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No components in \`${packageName}\` matched \`${query}\`.`;
  }
  const lines: string[] = [];
  lines.push(
    `# Search \`${packageName}\`: \`${query}\` (${hits.length} match${hits.length === 1 ? "" : "es"})`,
  );
  lines.push("");
  for (const hit of hits) {
    const summary = firstLine(hit.decl.summary ?? hit.decl.description);
    lines.push(`- \`${hit.decl.tagName}\`${summary ? ` — ${truncate(summary, 140)}` : ""}`);
    if (hit.reasons.length) {
      const unique = Array.from(new Set(hit.reasons)).slice(0, 4).join("; ");
      lines.push(`  · matched: ${unique}`);
    }
  }
  return lines.join("\n");
}

export interface CrossPackageHit {
  packageName: string;
  hit: SearchHit;
}

// Cross-package search output. Confident hits grouped by package; below-floor
// case returns the honest negative form (see formatNoCrossPackageMatch).
export function formatCrossPackageSearch(
  query: string,
  hits: CrossPackageHit[],
  packagesSearched: number,
): string {
  if (hits.length === 0) {
    return `No components across ${packagesSearched} package${packagesSearched === 1 ? "" : "s"} matched \`${query}\`.`;
  }
  const byPkg = new Map<string, SearchHit[]>();
  for (const { packageName, hit } of hits) {
    const arr = byPkg.get(packageName) ?? [];
    arr.push(hit);
    byPkg.set(packageName, arr);
  }
  const lines: string[] = [];
  lines.push(
    `# Cross-package search: \`${query}\` (${hits.length} match${hits.length === 1 ? "" : "es"} across ${byPkg.size} package${byPkg.size === 1 ? "" : "s"})`,
  );
  lines.push("");
  for (const [pkgName, pkgHits] of byPkg) {
    lines.push(`## ${pkgName}`);
    for (const h of pkgHits) {
      const summary = firstLine(h.decl.summary ?? h.decl.description);
      lines.push(`- \`${h.decl.tagName}\`${summary ? ` — ${truncate(summary, 140)}` : ""}`);
      if (h.reasons.length) {
        const unique = Array.from(new Set(h.reasons)).slice(0, 4).join("; ");
        lines.push(`  · matched: ${unique}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// Honest negative for cross-package search: when nothing scored above the
// confidence floor, return a brief "no good match" with at most a couple of
// near-miss leads, never the full noisy ranking.
export function formatNoCrossPackageMatch(
  query: string,
  packagesSearched: number,
  nearMisses: CrossPackageHit[],
): string {
  const lines: string[] = [];
  lines.push(
    `No good match for \`${query}\` across ${packagesSearched} package${packagesSearched === 1 ? "" : "s"}.`,
  );
  if (nearMisses.length) {
    lines.push("");
    lines.push("Closest leads (low confidence, may be unrelated):");
    for (const { packageName, hit } of nearMisses.slice(0, 3)) {
      const summary = firstLine(hit.decl.summary ?? hit.decl.description);
      lines.push(
        `- \`${hit.decl.tagName}\` (${packageName})${summary ? ` — ${truncate(summary, 100)}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

// --- internal section builders --------------------------------------------

function appendAttrs(lines: string[], attrs: CemAttribute[], heading = true): void {
  if (!attrs.length) return;
  if (heading) {
    lines.push("## attrs");
  }
  for (const a of attrs) {
    const type = a.type?.text ? ` \`${a.type.text}\`` : "";
    const def = a.default !== undefined ? ` (default \`${a.default}\`)` : "";
    lines.push(
      `- **${a.name}**${type}${def}${a.description ? ` — ${firstLine(a.description)}` : ""}`,
    );
  }
  if (heading) lines.push("");
}

function appendProperties(lines: string[], decl: CemDeclaration): void {
  const props = (decl.members ?? []).filter((m) => m.kind === "field" && m.privacy !== "private");
  if (!props.length) return;
  lines.push("## properties");
  for (const p of props) {
    const type = p.type?.text ? ` \`${p.type.text}\`` : "";
    const def = p.default !== undefined ? ` (default \`${p.default}\`)` : "";
    lines.push(
      `- **${p.name}**${type}${def}${p.description ? ` — ${firstLine(p.description)}` : ""}`,
    );
  }
  lines.push("");
}

function appendMethods(lines: string[], decl: CemDeclaration, heading = true): void {
  const methods = (decl.members ?? []).filter(
    (m) => m.kind === "method" && m.privacy !== "private",
  );
  if (!methods.length) return;
  if (heading) lines.push("## methods");
  for (const m of methods) {
    const params = (m.parameters ?? [])
      .map((p) => `${p.name}${p.type?.text ? `: ${p.type.text}` : ""}`)
      .join(", ");
    const ret = m.return?.type?.text ? `: ${m.return.type.text}` : "";
    lines.push(
      `- **${m.name}(${params})**${ret}${m.description ? ` — ${firstLine(m.description)}` : ""}`,
    );
  }
  if (heading) lines.push("");
}

function appendEvents(lines: string[], events: CemEvent[], heading = true): void {
  if (!events.length) return;
  if (heading) lines.push("## events");
  for (const e of events) {
    const type = e.type?.text ? ` \`${e.type.text}\`` : "";
    lines.push(`- **${e.name}**${type}${e.description ? ` — ${firstLine(e.description)}` : ""}`);
  }
  if (heading) lines.push("");
}

function appendSlots(
  lines: string[],
  slots: { name?: string; description?: string }[],
  heading = true,
): void {
  if (!slots.length) return;
  if (heading) lines.push("## slots");
  for (const s of slots) {
    const name = s.name ? `\`${s.name}\`` : "_(default)_";
    lines.push(`- ${name}${s.description ? ` — ${firstLine(s.description)}` : ""}`);
  }
  if (heading) lines.push("");
}

function appendCss(
  lines: string[],
  cssVars: { name: string; default?: string; description?: string }[],
  cssParts: { name: string; description?: string }[],
  heading = true,
): void {
  if (!cssVars.length && !cssParts.length) return;
  if (heading) lines.push("## css");
  if (cssVars.length) {
    lines.push("### custom properties");
    for (const c of cssVars) {
      const def = c.default !== undefined ? ` (default \`${c.default}\`)` : "";
      lines.push(`- **${c.name}**${def}${c.description ? ` — ${firstLine(c.description)}` : ""}`);
    }
  }
  if (cssParts.length) {
    lines.push("### shadow parts");
    for (const p of cssParts) {
      lines.push(`- **${p.name}**${p.description ? ` — ${firstLine(p.description)}` : ""}`);
    }
  }
  if (heading) lines.push("");
}

function appendExamples(lines: string[], examples: string[], heading = true): void {
  if (!examples.length) return;
  if (heading) lines.push("## examples");
  examples.forEach((ex, i) => {
    if (i > 0) lines.push("");
    lines.push("```");
    lines.push(ex.trim());
    lines.push("```");
  });
  if (heading) lines.push("");
}

// Pull `@example` blocks from the declaration's description when present.
// CEM schemas don't have a dedicated example field; convention is to embed
// them in jsdoc-style descriptions. Best-effort, conservative parse.
function extractExamples(decl: CemDeclaration): string[] {
  const text = decl.description ?? "";
  const out: string[] = [];
  const re = /@example\b\s*([\s\S]*?)(?=(?:\n\s*@\w+\b)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (body) out.push(body);
  }
  return out;
}
