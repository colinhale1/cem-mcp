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

function resolveProjectRoot(): string {
  const flagIdx = process.argv.indexOf("--project");
  const fromPositional = flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined;
  const fromEqFlag = process.argv
    .find((a) => a.startsWith("--project="))
    ?.slice("--project=".length);
  return resolve(fromEqFlag ?? fromPositional ?? process.env.CEM_PROJECT ?? process.cwd());
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
  "  - any other term → ranked fuzzy search across tag names, descriptions, attributes, events, slots, and CSS variables. A single hit returns full docs directly.",
  "",
  "Pass `query` as a string for one lookup, or an array of strings to look up several components from the same package in one call.",
].join("\n");

const ToolInput = z.object({
  package: z.string().min(1).optional(),
  query: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional(),
});

// A fuzzy result is "definitive" when its score is high in absolute terms
// and decisively above the runner-up. See docs/adr-0001-fuzzy-search.md for
// the scoring tiers these thresholds correspond to: 400 sits above acronym
// (~300) and partial token-set matches, and pulls in pascal/flat exacts.
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

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const registry = await CemRegistry.fromProject(projectRoot);

  const server = new Server(
    { name: "cem-mcp", version: "0.2.0" },
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
              text: formatPackageList(registry.packagesMeta(), registry.projectRoot),
            },
          ],
        };
      }

      if (!registry.has(pkgName)) {
        const available = registry.packageNames();
        const text =
          `Package \`${pkgName}\` was not found in the project.\n\n` +
          (available.length
            ? `Available: ${available.map((n) => `\`${n}\``).join(", ")}`
            : "No packages with a Custom Elements Manifest are installed under the project root.");
        return { isError: true, content: [{ type: "text", text }] };
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
  process.stderr.write(
    `cem-mcp ready · project ${projectRoot} · ${registry.packageNames().length} package(s) discovered\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`cem-mcp failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
