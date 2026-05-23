import type { DiscoveredPackage } from "./discovery.js";
import type { CemDeclaration, LoadedPackage, SearchHit } from "./cem.js";

const firstLine = (s: string | undefined): string =>
  (s ?? "").split(/\r?\n/)[0]?.trim() ?? "";

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

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
  lines.push("");
  lines.push("_Call this tool with `package: \"<name>\"` to list its components, or with `package` + `query` to look something up._");
  return lines.join("\n");
}

export function formatComponentList(pkg: LoadedPackage): string {
  const lines: string[] = [];
  const v = pkg.version ? `@${pkg.version}` : "";
  lines.push(`# \`${pkg.name}${v}\` — ${pkg.elements.length} components`);
  lines.push(`Source: \`${pkg.cemPath}\` · schema ${pkg.manifest.schemaVersion}`);
  lines.push("");
  const sorted = [...pkg.elements].sort((a, b) =>
    (a.tagName ?? "").localeCompare(b.tagName ?? ""),
  );
  for (const decl of sorted) {
    const summary = firstLine(decl.summary ?? decl.description);
    lines.push(`- \`${decl.tagName}\`${summary ? ` — ${truncate(summary, 140)}` : ""}`);
  }
  lines.push("");
  lines.push("_Call this tool with an exact tag name as `query` for full docs, or any term to fuzzy-search._");
  return lines.join("\n");
}

export function formatElement(decl: CemDeclaration, packageName?: string): string {
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

  const attrs = decl.attributes ?? [];
  if (attrs.length) {
    lines.push("## Attributes");
    for (const a of attrs) {
      const type = a.type?.text ? ` \`${a.type.text}\`` : "";
      const def = a.default !== undefined ? ` (default \`${a.default}\`)` : "";
      lines.push(`- **${a.name}**${type}${def}${a.description ? ` — ${firstLine(a.description)}` : ""}`);
    }
    lines.push("");
  }

  const props = (decl.members ?? []).filter((m) => m.kind === "field" && m.privacy !== "private");
  if (props.length) {
    lines.push("## Properties");
    for (const p of props) {
      const type = p.type?.text ? ` \`${p.type.text}\`` : "";
      const def = p.default !== undefined ? ` (default \`${p.default}\`)` : "";
      lines.push(`- **${p.name}**${type}${def}${p.description ? ` — ${firstLine(p.description)}` : ""}`);
    }
    lines.push("");
  }

  const methods = (decl.members ?? []).filter((m) => m.kind === "method" && m.privacy !== "private");
  if (methods.length) {
    lines.push("## Methods");
    for (const m of methods) {
      const params = (m.parameters ?? [])
        .map((p) => `${p.name}${p.type?.text ? `: ${p.type.text}` : ""}`)
        .join(", ");
      const ret = m.return?.type?.text ? `: ${m.return.type.text}` : "";
      lines.push(`- **${m.name}(${params})**${ret}${m.description ? ` — ${firstLine(m.description)}` : ""}`);
    }
    lines.push("");
  }

  const events = decl.events ?? [];
  if (events.length) {
    lines.push("## Events");
    for (const e of events) {
      const type = e.type?.text ? ` \`${e.type.text}\`` : "";
      lines.push(`- **${e.name}**${type}${e.description ? ` — ${firstLine(e.description)}` : ""}`);
    }
    lines.push("");
  }

  const slots = decl.slots ?? [];
  if (slots.length) {
    lines.push("## Slots");
    for (const s of slots) {
      const name = s.name ? `\`${s.name}\`` : "_(default)_";
      lines.push(`- ${name}${s.description ? ` — ${firstLine(s.description)}` : ""}`);
    }
    lines.push("");
  }

  const cssVars = decl.cssProperties ?? [];
  if (cssVars.length) {
    lines.push("## CSS Custom Properties");
    for (const c of cssVars) {
      const def = c.default !== undefined ? ` (default \`${c.default}\`)` : "";
      lines.push(`- **${c.name}**${def}${c.description ? ` — ${firstLine(c.description)}` : ""}`);
    }
    lines.push("");
  }

  const parts = decl.cssParts ?? [];
  if (parts.length) {
    lines.push("## CSS Shadow Parts");
    for (const p of parts) {
      lines.push(`- **${p.name}**${p.description ? ` — ${firstLine(p.description)}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
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

export function formatSearch(packageName: string, query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No components in \`${packageName}\` matched \`${query}\`. Try a different term, or call with just \`package\` to list everything.`;
  }
  const lines: string[] = [];
  lines.push(`# Search \`${packageName}\`: \`${query}\` (${hits.length} match${hits.length === 1 ? "" : "es"})`);
  lines.push("");
  for (const hit of hits) {
    const summary = firstLine(hit.decl.summary ?? hit.decl.description);
    lines.push(`- \`${hit.decl.tagName}\`${summary ? ` — ${truncate(summary, 140)}` : ""}`);
    if (hit.reasons.length) {
      const unique = Array.from(new Set(hit.reasons)).slice(0, 4).join("; ");
      lines.push(`  · matched: ${unique}`);
    }
  }
  lines.push("");
  lines.push("_Call this tool again with an exact tag name for full docs._");
  return lines.join("\n");
}
