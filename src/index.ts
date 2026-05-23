#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadCem, searchElements, type LoadedCem } from "./cem.js";
import { formatElement, formatList, formatMulti, formatSearch } from "./format.js";

function resolveCemPath(): string {
  const fromFlag = process.argv.find((a) => a.startsWith("--cem="))?.slice("--cem=".length);
  const flagIdx = process.argv.indexOf("--cem");
  const fromPositional = flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined;
  const path = fromFlag ?? fromPositional ?? process.env.CEM_PATH;
  if (!path) {
    throw new Error(
      "No CEM path provided. Pass --cem <path> or set CEM_PATH to a custom-elements.json file.",
    );
  }
  return path;
}

const QUERY_DESCRIPTION =
  'A single query string, or an array of query strings for multi-lookup in one call. ' +
  'Each query is dispatched independently: "all" lists every component; an exact tag name ' +
  '(e.g. "calcite-button", case-insensitive) returns full docs; any other term performs a ' +
  'ranked fuzzy search across tag names, descriptions, attributes, events, slots, and CSS variables.';

const ToolInput = z.object({
  query: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe(QUERY_DESCRIPTION),
});

const TOOL_NAME = "get_component_docs";

const TOOL_DESCRIPTION = [
  "Look up repo-accurate web component documentation from the loaded Custom Elements Manifest.",
  "",
  "Pass `query` as a string for a single lookup, or as an array of strings to look up several",
  "things in one call. Each query is dispatched independently:",
  '- `"all"` → markdown list of every component with a one-line summary.',
  "- exact tag name (case-insensitive) → full docs: attributes, properties, methods, events, slots, CSS custom properties, CSS shadow parts.",
  "- any other term/phrase → ranked fuzzy search across tag names, descriptions, attributes, events, slots, and CSS variables.",
  "",
  'Examples: `query: "calcite-button"` · `query: ["calcite-button", "alert", "date picker"]`.',
].join("\n");

function handleQuery(cem: LoadedCem, rawQuery: string): string {
  const query = rawQuery.trim();
  if (!query) return "Empty query. Pass 'all', an exact tag name, or a search term.";

  if (query.toLowerCase() === "all") {
    return formatList(cem);
  }

  const exact = cem.byTag.get(query.toLowerCase());
  if (exact) return formatElement(exact);

  const hits = searchElements(cem, query);
  if (hits.length === 1) {
    // Unambiguous fuzzy match → return full docs directly.
    return formatElement(hits[0].decl);
  }
  return formatSearch(query, hits);
}

function handleQueries(cem: LoadedCem, queries: string[]): string {
  if (queries.length === 1) return handleQuery(cem, queries[0]);
  const sections = queries.map((q) => ({ query: q, body: handleQuery(cem, q) }));
  return formatMulti(sections);
}

async function main(): Promise<void> {
  const cemPath = resolveCemPath();
  const cem = await loadCem(cemPath);

  const server = new Server(
    { name: "cem-mcp", version: "0.1.0" },
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
            query: {
              description: QUERY_DESCRIPTION,
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
          required: ["query"],
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
      const queries = Array.isArray(parsed.data.query)
        ? parsed.data.query
        : [parsed.data.query];
      const text = handleQueries(cem, queries);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for MCP protocol traffic.
  process.stderr.write(
    `cem-mcp ready · ${cem.elements.length} components from ${cem.sourcePath}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`cem-mcp failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
