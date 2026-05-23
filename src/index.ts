#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { z } from "zod";

import { CemRegistry, searchElements, type LoadedPackage } from "./cem.js";
import {
  formatComponentList,
  formatElement,
  formatMulti,
  formatPackageList,
  formatSearch,
} from "./format.js";
import { suggestPackages } from "./suggest.js";

function readFlag(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`))?.slice(`${name}=`.length);
  if (eq !== undefined) return eq;
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function resolveProjectRoot(): string {
  return resolve(readFlag("--project") ?? process.env.CEM_PROJECT ?? process.cwd());
}

function resolveConfigPath(): string | undefined {
  return readFlag("--config") ?? process.env.CEM_CONFIG;
}

const TOOL_NAME = "get_component_docs";

const TOOL_DESCRIPTION = [
  "Look up repo-accurate web component documentation from Custom Elements Manifests",
  "shipped by packages in the project's `node_modules`.",
  "",
  "Both parameters are optional:",
  "- No arguments → list every package the server has discovered.",
  "- `package` only → list every component in that package.",
  "- `package` + `query` → dispatch the query against that package:",
  '  - `query: "all"` → list components (same as omitting query)',
  "  - exact tag name (case-insensitive) → full docs (attributes, properties, methods, events, slots, CSS vars, CSS parts)",
  "  - any other term → ranked fuzzy search across tag names, descriptions, attributes, events, slots, and CSS variables. A clear-winner hit returns full docs directly.",
  "",
  "Pass `query` as a string for one lookup, or an array of strings to look up several components from the same package in one call.",
].join("\n");

const ToolInput = z.object({
  package: z.string().min(1).optional(),
  query: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional(),
});

// A fuzzy result is "definitive" when its score is high in absolute terms and
// decisively above the runner-up. Thresholds derived empirically; see
// docs/adr-0001-fuzzy-search.md.
const PROMOTE_MIN_SCORE = 400;
const PROMOTE_MIN_RATIO = 2;

function isDefinitive(hits: { score: number }[]): boolean {
  if (hits.length === 0) return false;
  if (hits.length === 1) return true;
  return hits[0].score >= PROMOTE_MIN_SCORE && hits[0].score >= PROMOTE_MIN_RATIO * hits[1].score;
}

function handleQuery(pkg: LoadedPackage, rawQuery: string): string {
  const query = rawQuery.trim();
  if (!query || query.toLowerCase() === "all") return formatComponentList(pkg);

  const exact = pkg.byTag.get(query.toLowerCase());
  if (exact) return formatElement(exact, pkg.name);

  const hits = searchElements(pkg, query);
  if (isDefinitive(hits)) return formatElement(hits[0].decl, pkg.name);
  return formatSearch(pkg.name, query, hits);
}

function handleQueries(pkg: LoadedPackage, queries: string[]): string {
  if (queries.length === 1) return handleQuery(pkg, queries[0]);
  const sections = queries.map((q) => ({ query: q, body: handleQuery(pkg, q) }));
  return formatMulti(pkg.name, sections);
}

function unknownPackageMessage(pkgName: string, available: string[]): string {
  const lines: string[] = [];
  lines.push(`Package \`${pkgName}\` was not found in the project.`);
  if (available.length === 0) {
    lines.push("");
    lines.push("No packages with a Custom Elements Manifest are installed under the project root.");
    return lines.join("\n");
  }
  const suggestions = suggestPackages(pkgName, available);
  if (suggestions.length) {
    lines.push("");
    lines.push(`Did you mean: ${suggestions.map((n) => `\`${n}\``).join(", ")}?`);
  }
  lines.push("");
  lines.push(`Available: ${available.map((n) => `\`${n}\``).join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const configPath = resolveConfigPath();
  const registry = await CemRegistry.fromProject(projectRoot, { configPath });

  const server = new Server(
    { name: "cem-mcp", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            package: {
              type: "string",
              description:
                "Name of the package to query (e.g. '@esri/calcite-components'). Omit to list available packages.",
            },
            query: {
              description:
                'Either "all"/omitted to list components, an exact tag name for full docs, or any term to fuzzy-search. Pass an array of strings for a multi-lookup within the same package.',
              oneOf: [
                { type: "string", minLength: 1 },
                {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  minItems: 1,
                },
              ],
            },
          },
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== TOOL_NAME) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    const parsed = ToolInput.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
      };
    }

    try {
      const { package: pkgName, query } = parsed.data;

      if (!pkgName) {
        return {
          content: [
            {
              type: "text",
              text: formatPackageList(
                registry.packagesMeta(),
                registry.projectRoot,
                registry.config.sourcePath,
              ),
            },
          ],
        };
      }

      if (!registry.has(pkgName)) {
        return {
          isError: true,
          content: [
            { type: "text", text: unknownPackageMessage(pkgName, registry.packageNames()) },
          ],
        };
      }

      const pkg = await registry.get(pkgName);

      if (query === undefined) {
        return { content: [{ type: "text", text: formatComponentList(pkg) }] };
      }

      const queries = Array.isArray(query) ? query : [query];
      return { content: [{ type: "text", text: handleQueries(pkg, queries) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for MCP protocol traffic.
  const pkgCount = registry.packageNames().length;
  const cfg = registry.config.sourcePath ? ` · config ${registry.config.sourcePath}` : "";
  process.stderr.write(
    `cem-mcp ready · project ${projectRoot} · ${pkgCount} package(s) discovered${cfg}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`cem-mcp failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
