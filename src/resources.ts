// MCP resources surface for cem-mcp. See docs/adr-0004-mcp-resources.md.
//
// Exposes every loaded component as a pinnable resource at a stable URI.
// Tools (get_component_docs, validate_component_usage) are untouched —
// resources are additive. The compact view is the resource content because
// the bench in bench/session-context.ts confirmed pinning the full ~2 K-token
// view is too costly when spread across the session.
//
// URI scheme: `cem://<package-name>/<tag-name>`.
//
// Scoped packages (`@scope/name`) are NOT URL-encoded; the parser splits
// on the LAST `/` so `cem://@shoelace-style/shoelace/sl-button` resolves
// to package `@shoelace-style/shoelace` and tag `sl-button`.

import type { CemRegistry } from "./cem.js";
import { formatElementCompact } from "./format.js";

export const CEM_URI_SCHEME = "cem://";
export const CEM_RESOURCE_MIME = "text/markdown";

export interface ResourceMetadata {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ParsedResourceUri {
  packageName: string;
  tagName: string;
}

export function buildResourceUri(packageName: string, tagName: string): string {
  return `${CEM_URI_SCHEME}${packageName}/${tagName}`;
}

export function parseResourceUri(uri: string): ParsedResourceUri {
  if (!uri.startsWith(CEM_URI_SCHEME)) {
    throw new Error(
      `Invalid resource URI scheme: \`${uri}\`. Expected \`${CEM_URI_SCHEME}<package>/<tag>\`.`,
    );
  }
  const rest = uri.slice(CEM_URI_SCHEME.length);
  const lastSlash = rest.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash === rest.length - 1) {
    throw new Error(
      `Invalid resource URI: \`${uri}\`. Expected \`${CEM_URI_SCHEME}<package>/<tag>\` with a non-empty package and tag.`,
    );
  }
  return { packageName: rest.slice(0, lastSlash), tagName: rest.slice(lastSlash + 1) };
}

// Builds the full catalog: one entry per loaded component across all
// discovered packages. Metadata only (no compact view) — the agent reads
// content lazily via `resources/read` for components it actually wants
// to pin. NOTE: per the bench, agents that already know URIs should skip
// `resources/list` entirely and construct URIs directly. The catalog
// pays its cost when the client surfaces it (e.g. for a user pin UX).
export async function listResources(registry: CemRegistry): Promise<ResourceMetadata[]> {
  const out: ResourceMetadata[] = [];
  for (const pkgName of registry.packageNames()) {
    const pkg = await registry.get(pkgName);
    for (const decl of pkg.elements) {
      if (!decl.tagName) continue;
      const firstLine = (decl.summary ?? decl.description ?? "").split("\n")[0]?.trim() ?? "";
      out.push({
        uri: buildResourceUri(pkg.name, decl.tagName),
        name: decl.tagName,
        description: firstLine,
        mimeType: CEM_RESOURCE_MIME,
      });
    }
  }
  return out;
}

// Resolves a `cem://pkg/tag` URI to the compact-view markdown for the
// component. Throws on unknown package, unknown tag, or malformed URI.
export async function readResource(registry: CemRegistry, uri: string): Promise<string> {
  const { packageName, tagName } = parseResourceUri(uri);
  if (!registry.has(packageName)) {
    throw new Error(
      `Unknown package in resource URI: \`${packageName}\`. Available: ${registry.packageNames().join(", ") || "(none)"}.`,
    );
  }
  const pkg = await registry.get(packageName);
  // Tag lookup is case-insensitive — HTML tag names normalize to lowercase.
  const decl = pkg.byTag.get(tagName.toLowerCase());
  if (!decl) {
    throw new Error(`Unknown component \`${tagName}\` in package \`${packageName}\`.`);
  }
  return formatElementCompact(decl, pkg.name);
}
