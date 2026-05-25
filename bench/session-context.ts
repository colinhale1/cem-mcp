// Session-context benchmark for ADR-0004.
//
// Models a realistic coding session against the cem-mcp tool surface and
// measures the per-session context cost (bytes of tool/resource I/O) under
// three configurations:
//
//   - tool-only        : the current 1.2 baseline. Every component reference
//                        is a `get_component_docs` call. No state preserved
//                        across turns; each call pays full I/O.
//   - resources-full   : ADR-0004 v1 as written. Agent calls `resources/list`
//                        at session start to discover available URIs, then
//                        pins components via `resources/read`. Worst case
//                        for clients that surface the full list to the LLM.
//   - resources-no-list: realistic best case. Agent skips `resources/list`
//                        and constructs URIs directly (cem://pkg/tag) from
//                        names it already knows (from a single
//                        get_component_docs call, prior context, or the
//                        user's prompt). Only pays for resources/read.
//
// In both resource configurations, "lookup" steps for pinned components
// resolve to zero additional I/O (the content was delivered at pin time
// and lives in the agent's context for the remainder of the session).
// Drill-downs and validate calls are unchanged — still tool calls.
//
// What the harness does NOT measure:
//   - The token cost of the agent's own prompts/responses (out of scope —
//     same across both configurations).
//   - Disk I/O, parse time, server CPU. The relevant dimension is bytes
//     that flow into the model's context window.
//
// What it DOES measure:
//   - Total bytes (request + response) of every tool call and resource
//     access. JSON-stringified for a fair comparison with the on-wire
//     payload size the MCP client would actually deliver to the agent.
//   - Estimated tokens at 4 bytes/token (a conservative English-text
//     heuristic; good enough for relative comparisons).
//
// Sessions are hand-curated to mirror real agent behavior patterns
// surfaced by the post-1.1 head-to-head evaluation: building a form,
// configuring a complex component, comparing across libraries, validating
// snippets the agent just wrote.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

import { CemRegistry, searchElements } from "../src/cem.js";
import {
  formatAspect,
  formatAttribute,
  formatElementCompact,
  formatEventDetail,
  formatSearch,
} from "../src/format.js";
import { formatValidationResult, validateSnippet } from "../src/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "../test/fixtures/project");

// --- session DSL -----------------------------------------------------------

type Step =
  | { type: "lookup"; pkg: string; tag: string }
  | { type: "drilldown"; pkg: string; tag: string; aspect: Parameters<typeof formatAspect>[1] }
  | { type: "attr"; pkg: string; tag: string; attr: string }
  | { type: "event"; pkg: string; tag: string; event: string }
  | { type: "search"; pkg: string; query: string }
  | { type: "validate"; snippet: string };

interface Session {
  name: string;
  description: string;
  // Components the agent decides up-front it will work with. In the
  // resources configuration these get pinned at session start; in the
  // tool-only configuration they're irrelevant to the cost model.
  pinned: { pkg: string; tag: string }[];
  steps: Step[];
}

// --- I/O cost model --------------------------------------------------------

// The on-wire size of a tool call is: input args (sent to the server) +
// response content (sent back to the agent). We approximate input args as
// the JSON-stringified params object; response as JSON-stringified content
// (the MCP envelope is fixed overhead, ignored here for fairness — both
// configurations pay it equally).
function callCost(input: object, responseText: string): number {
  return Buffer.byteLength(JSON.stringify(input), "utf8") + Buffer.byteLength(responseText, "utf8");
}

// MCP resources/list returns a metadata-only catalog. Cost is paid once at
// session start in the resources configuration.
function listCost(entries: { uri: string; name: string; description: string }[]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

// MCP resources/read returns one resource's content. In the resources
// configuration the agent calls this once per pinned component at session
// start; the content stays in context for the rest of the session.
function readCost(uri: string, content: string): number {
  return Buffer.byteLength(JSON.stringify({ uri }), "utf8") + Buffer.byteLength(content, "utf8");
}

const BYTES_PER_TOKEN_EST = 4;
function toTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN_EST);
}

// --- executors -------------------------------------------------------------

interface Trace {
  totalBytes: number;
  callCount: number;
  details: { kind: string; bytes: number }[];
}

// Resolves a step against the actual loaded package, returning the response
// text the MCP server would produce. The harness then accounts the bytes.
async function executeToolStep(
  reg: CemRegistry,
  step: Step,
): Promise<{ input: object; text: string }> {
  if (step.type === "validate") {
    const r = await validateSnippet(reg, step.snippet);
    return { input: { snippet: step.snippet }, text: formatValidationResult(r) };
  }
  if (step.type === "search") {
    const pkg = await reg.get(step.pkg);
    const hits = searchElements(pkg, step.query);
    return {
      input: { package: step.pkg, query: step.query },
      text: formatSearch(pkg.name, step.query, hits),
    };
  }
  const pkg = await reg.get(step.pkg);
  if (step.type === "lookup") {
    const decl = pkg.byTag.get(step.tag);
    if (!decl) throw new Error(`fixture missing tag ${step.tag} in ${step.pkg}`);
    return {
      input: { package: step.pkg, query: step.tag },
      text: formatElementCompact(decl, pkg.name),
    };
  }
  if (step.type === "drilldown") {
    const decl = pkg.byTag.get(step.tag);
    if (!decl) throw new Error(`fixture missing tag ${step.tag} in ${step.pkg}`);
    return {
      input: { package: step.pkg, query: step.tag, aspect: step.aspect },
      text: formatAspect(decl, step.aspect, pkg.name),
    };
  }
  if (step.type === "attr") {
    const decl = pkg.byTag.get(step.tag);
    if (!decl) throw new Error(`fixture missing tag ${step.tag} in ${step.pkg}`);
    const text = formatAttribute(decl, step.attr, pkg.name);
    if (text === null) throw new Error(`fixture missing attr ${step.attr} on ${step.tag}`);
    return { input: { package: step.pkg, query: step.tag, attr: step.attr }, text };
  }
  if (step.type === "event") {
    const decl = pkg.byTag.get(step.tag);
    if (!decl) throw new Error(`fixture missing tag ${step.tag} in ${step.pkg}`);
    const text = formatEventDetail(decl, step.event, pkg.name);
    if (text === null) throw new Error(`fixture missing event ${step.event} on ${step.tag}`);
    return { input: { package: step.pkg, query: step.tag, event: step.event }, text };
  }
  throw new Error(`unknown step type`);
}

async function runToolOnly(reg: CemRegistry, session: Session): Promise<Trace> {
  const trace: Trace = { totalBytes: 0, callCount: 0, details: [] };
  for (const step of session.steps) {
    const { input, text } = await executeToolStep(reg, step);
    const bytes = callCost(input, text);
    trace.totalBytes += bytes;
    trace.callCount++;
    trace.details.push({ kind: step.type, bytes });
  }
  return trace;
}

async function runResources(
  reg: CemRegistry,
  session: Session,
  includeList: boolean,
): Promise<Trace> {
  const trace: Trace = { totalBytes: 0, callCount: 0, details: [] };

  // Step 1 (optional) — `resources/list` at session start. Metadata-only
  // catalog of every component the registry knows about. Skipped when the
  // agent constructs URIs directly from prior knowledge.
  if (includeList) {
    const allTags: { uri: string; name: string; description: string }[] = [];
    for (const pkgName of reg.packageNames()) {
      const pkg = await reg.get(pkgName);
      for (const decl of pkg.elements) {
        if (!decl.tagName) continue;
        allTags.push({
          uri: `cem://${pkg.name}/${decl.tagName}`,
          name: decl.tagName,
          description: (decl.summary ?? decl.description ?? "").split("\n")[0]?.trim() ?? "",
        });
      }
    }
    const listBytes = listCost(allTags);
    trace.totalBytes += listBytes;
    trace.details.push({ kind: "resources/list", bytes: listBytes });
  }

  // Step 2 — pin each component the session declared up-front by calling
  // resources/read once each. Cost paid once; content lives in context.
  const pinned = new Set<string>();
  for (const p of session.pinned) {
    const pkg = await reg.get(p.pkg);
    const decl = pkg.byTag.get(p.tag);
    if (!decl) throw new Error(`fixture missing pinned tag ${p.tag} in ${p.pkg}`);
    const content = formatElementCompact(decl, pkg.name);
    const uri = `cem://${pkg.name}/${decl.tagName}`;
    const bytes = readCost(uri, content);
    trace.totalBytes += bytes;
    trace.callCount++;
    trace.details.push({ kind: "resources/read", bytes });
    pinned.add(`${p.pkg}::${p.tag}`);
  }

  // Step 3 — walk the session steps. `lookup` steps for pinned components
  // are free (the compact view was delivered at pin time). All other steps
  // are still tool calls.
  for (const step of session.steps) {
    if (step.type === "lookup" && pinned.has(`${step.pkg}::${step.tag}`)) {
      trace.details.push({ kind: "lookup (pinned, free)", bytes: 0 });
      continue;
    }
    const { input, text } = await executeToolStep(reg, step);
    const bytes = callCost(input, text);
    trace.totalBytes += bytes;
    trace.callCount++;
    trace.details.push({ kind: step.type, bytes });
  }
  return trace;
}

// --- sessions --------------------------------------------------------------
// Hand-curated to mirror real agent behavior patterns. Each session
// represents a coherent multi-turn task an agent might walk through.

const SESSIONS: Session[] = [
  {
    name: "build-shoelace-form",
    description:
      "Agent builds a form with three Shoelace inputs + a button. Looks each up, drills into attrs of two, validates the assembled snippet.",
    pinned: [
      { pkg: "@shoelace-style/shoelace", tag: "sl-input" },
      { pkg: "@shoelace-style/shoelace", tag: "sl-textarea" },
      { pkg: "@shoelace-style/shoelace", tag: "sl-button" },
    ],
    steps: [
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-input" },
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-textarea" },
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-button" },
      { type: "drilldown", pkg: "@shoelace-style/shoelace", tag: "sl-input", aspect: "attrs" },
      { type: "drilldown", pkg: "@shoelace-style/shoelace", tag: "sl-button", aspect: "attrs" },
      // Agent re-reads compact view of sl-input mid-task (context compaction
      // or plan change) — in tool-only this is another full call; with
      // resources it's free.
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-input" },
      { type: "attr", pkg: "@shoelace-style/shoelace", tag: "sl-button", attr: "variant" },
      // Agent goes back to sl-textarea to check it has a `rows` attr.
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-textarea" },
      {
        type: "validate",
        snippet:
          '<sl-input label="Name" required></sl-input>\n<sl-textarea label="Message" rows="4"></sl-textarea>\n<sl-button variant="primary" type="submit">Send</sl-button>',
      },
    ],
  },
  {
    name: "calcite-combobox-config",
    description:
      "Agent works on a single complex component (calcite-combobox), checks attrs, events, validates two snippets.",
    pinned: [{ pkg: "@esri/calcite-components", tag: "calcite-combobox" }],
    steps: [
      { type: "lookup", pkg: "@esri/calcite-components", tag: "calcite-combobox" },
      {
        type: "drilldown",
        pkg: "@esri/calcite-components",
        tag: "calcite-combobox",
        aspect: "attrs",
      },
      {
        type: "drilldown",
        pkg: "@esri/calcite-components",
        tag: "calcite-combobox",
        aspect: "events",
      },
      { type: "lookup", pkg: "@esri/calcite-components", tag: "calcite-combobox" }, // re-read after compaction
      {
        type: "event",
        pkg: "@esri/calcite-components",
        tag: "calcite-combobox",
        event: "calciteComboboxChange",
      },
      {
        type: "validate",
        snippet:
          '<calcite-combobox label="Tags" @calciteComboboxChange="onChange"></calcite-combobox>',
      },
      { type: "lookup", pkg: "@esri/calcite-components", tag: "calcite-combobox" }, // re-read again
      {
        type: "validate",
        snippet:
          '<calcite-combobox .filteredItems=${arr} @calciteComboboxChange="onChange"></calcite-combobox>',
      },
    ],
  },
  {
    name: "cross-library-comparison",
    description:
      "Agent compares the button component across three libraries before picking one. Lookups happen multiple times per library as the agent reasons.",
    pinned: [
      { pkg: "@shoelace-style/shoelace", tag: "sl-button" },
      { pkg: "@esri/calcite-components", tag: "calcite-button" },
      { pkg: "@nordhealth/components", tag: "nord-button" },
    ],
    steps: [
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-button" },
      { type: "lookup", pkg: "@esri/calcite-components", tag: "calcite-button" },
      { type: "lookup", pkg: "@nordhealth/components", tag: "nord-button" },
      { type: "drilldown", pkg: "@shoelace-style/shoelace", tag: "sl-button", aspect: "attrs" },
      {
        type: "drilldown",
        pkg: "@esri/calcite-components",
        tag: "calcite-button",
        aspect: "attrs",
      },
      // Agent goes back to re-check sl-button after seeing calcite's attrs.
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-button" },
      { type: "lookup", pkg: "@esri/calcite-components", tag: "calcite-button" },
      { type: "drilldown", pkg: "@nordhealth/components", tag: "nord-button", aspect: "attrs" },
      { type: "lookup", pkg: "@nordhealth/components", tag: "nord-button" }, // final check before deciding
    ],
  },
  {
    name: "short-single-lookup",
    description:
      "Agent does one quick lookup, drills into one attribute, validates a snippet. No re-reads. Worst case for resources — no benefit from pinning.",
    pinned: [{ pkg: "@shoelace-style/shoelace", tag: "sl-button" }],
    steps: [
      { type: "lookup", pkg: "@shoelace-style/shoelace", tag: "sl-button" },
      { type: "attr", pkg: "@shoelace-style/shoelace", tag: "sl-button", attr: "variant" },
      { type: "validate", snippet: '<sl-button variant="primary">Save</sl-button>' },
    ],
  },
];

// --- runner ----------------------------------------------------------------

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  const v = (numerator / denominator) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

async function main(): Promise<void> {
  if (!existsSync(PROJECT)) {
    console.error(`Fixture missing at ${PROJECT}. Run \`npm run fetch-libs\` first.`);
    process.exit(1);
  }
  const reg = await CemRegistry.fromProject(PROJECT);

  console.log("# Session-context benchmark (ADR-0004)");
  console.log("");
  console.log("Measures total bytes of tool/resource I/O per session under three configurations.");
  console.log("");
  console.log("Configurations:");
  console.log("  - tool-only        : every component reference is a get_component_docs call.");
  console.log(
    "  - resources+list   : agent calls resources/list at start, then pins via resources/read.",
  );
  console.log(
    "  - resources no-list: agent skips resources/list; constructs URIs directly. Realistic best case.",
  );
  console.log("");
  console.log("Token estimates use 4 bytes/token (conservative English heuristic).");
  console.log("");
  console.log("Discovery scope: " + reg.packageNames().length + " packages.");
  console.log("");

  let toolTotal = 0;
  let resFullTotal = 0;
  let resNoListTotal = 0;

  console.log(
    pad("session", 28) +
      rpad("tool-only", 12) +
      rpad("res+list", 12) +
      rpad("res no-list", 13) +
      rpad("Δ no-list", 12) +
      rpad("Δ %", 9),
  );
  console.log("-".repeat(86));

  const runs: Array<{
    session: Session;
    tool: Trace;
    resFull: Trace;
    resNoList: Trace;
  }> = [];

  for (const session of SESSIONS) {
    const tool = await runToolOnly(reg, session);
    const resFull = await runResources(reg, session, /*includeList*/ true);
    const resNoList = await runResources(reg, session, /*includeList*/ false);
    toolTotal += tool.totalBytes;
    resFullTotal += resFull.totalBytes;
    resNoListTotal += resNoList.totalBytes;
    runs.push({ session, tool, resFull, resNoList });
    const deltaNoList = resNoList.totalBytes - tool.totalBytes;
    console.log(
      pad(session.name, 28) +
        rpad(tool.totalBytes.toLocaleString(), 12) +
        rpad(resFull.totalBytes.toLocaleString(), 12) +
        rpad(resNoList.totalBytes.toLocaleString(), 13) +
        rpad((deltaNoList >= 0 ? "+" : "") + deltaNoList.toLocaleString(), 12) +
        rpad(pct(deltaNoList, tool.totalBytes), 9),
    );
  }
  console.log("-".repeat(86));
  const totalDeltaNoList = resNoListTotal - toolTotal;
  console.log(
    pad("TOTAL", 28) +
      rpad(toolTotal.toLocaleString(), 12) +
      rpad(resFullTotal.toLocaleString(), 12) +
      rpad(resNoListTotal.toLocaleString(), 13) +
      rpad((totalDeltaNoList >= 0 ? "+" : "") + totalDeltaNoList.toLocaleString(), 12) +
      rpad(pct(totalDeltaNoList, toolTotal), 9),
  );
  console.log("");
  console.log("Token estimates (~4 bytes/token):");
  console.log(`  tool-only       : ${toTokens(toolTotal).toLocaleString()} tokens`);
  console.log(`  resources+list  : ${toTokens(resFullTotal).toLocaleString()} tokens`);
  console.log(`  resources no-list: ${toTokens(resNoListTotal).toLocaleString()} tokens`);

  console.log("");
  console.log("## Per-session detail");
  for (const { session, tool, resFull, resNoList } of runs) {
    console.log("");
    console.log(`### ${session.name}`);
    console.log(`  ${session.description}`);
    console.log(
      `  tool-only        : ${tool.totalBytes.toLocaleString()} B / ~${toTokens(tool.totalBytes).toLocaleString()} tokens / ${tool.callCount} calls`,
    );
    console.log(
      `  resources+list   : ${resFull.totalBytes.toLocaleString()} B / ~${toTokens(resFull.totalBytes).toLocaleString()} tokens / ${resFull.callCount} calls`,
    );
    console.log(
      `  resources no-list: ${resNoList.totalBytes.toLocaleString()} B / ~${toTokens(resNoList.totalBytes).toLocaleString()} tokens / ${resNoList.callCount} calls`,
    );
    const dNoList = resNoList.totalBytes - tool.totalBytes;
    console.log(
      `  delta (no-list)  : ${dNoList >= 0 ? "+" : ""}${dNoList.toLocaleString()} B (${pct(dNoList, tool.totalBytes)})`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
