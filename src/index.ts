#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadCem, searchElements, type LoadedCem } from "./cem.js";
import { formatElement, formatList, formatSearch } from "./format.js";

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

const ToolInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Either "all" to list every component, an exact tag name (e.g. "calcite-button") for full docs, or any term/phrase to search across components.',
    ),
});

const TOOL_NAME = "get_component_docs";

const TOOL_DESCRIPTION = [
  "Look up repo-accurate web component documentation from the loaded Custom Elements Manifest.",
  "",
  "Dispatch by `query`:",
  '- `"all"` → markdown list of every component with a one-line summary.',
  "- exact tag name (case-insensitive) → full docs: attributes, properties, methods, events, slots, CSS custom properties, CSS shadow parts.",
  "- any other term/phrase → ranked search across tag names, descriptions, attributes, events, slots, and CSS variables.",
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
              type: "string",
              description: ToolInput.shape.query.description,
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
      const text = handleQuery(cem, parsed.data.query);
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
