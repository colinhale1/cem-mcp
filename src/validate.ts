// HTML snippet validator for web components. Parses <tag attr="value"> usage
// patterns and checks them against the loaded CEM registry: tag is known,
// attributes exist on the tag, and enum-typed attribute values are members
// of their declared union. See docs/adr-0002-tool-shape.md for scope rationale.

import type { CemRegistry } from "./cem.js";
import { suggestPackages } from "./suggest.js";

export interface ValidationIssue {
  kind: "unknown-tag" | "unknown-attr" | "invalid-value";
  tag: string;
  attr?: string;
  value?: string;
  message: string;
  suggestion?: string;
  // 1-based line + column of the issue within the snippet, for agents that
  // want to surface them.
  line: number;
  column: number;
}

export interface ValidationResult {
  tagsFound: number;
  tagsValidated: number;
  issues: ValidationIssue[];
}

// Standard HTML global attributes and namespaces we never flag as unknown,
// even when they don't appear in the CEM. ARIA / data-* / event handlers are
// handled by prefix checks below.
const GLOBAL_ATTRS = new Set([
  "id",
  "class",
  "style",
  "title",
  "lang",
  "dir",
  "hidden",
  "tabindex",
  "role",
  "slot",
  "part",
  "is",
  "draggable",
  "spellcheck",
  "translate",
  "contenteditable",
  "autofocus",
  "accesskey",
  "inputmode",
  "enterkeyhint",
  "exportparts",
  "popover",
  "ref", // Lit/React-style; agents emit it on web components too
  "key",
]);

function isGlobalAttr(name: string): boolean {
  if (GLOBAL_ATTRS.has(name)) return true;
  if (name.startsWith("data-")) return true;
  if (name.startsWith("aria-")) return true;
  if (name.startsWith("on")) return true; // onclick, onfoo-bar, etc.
  // Binding prefixes (`:`, `@`, `.`, `?`) intentionally do NOT short-circuit
  // here — they're handled in the main loop so we can still validate the
  // underlying attribute/event name. `@` indicates an event binding and
  // `.` indicates a property binding; both are skipped at the attribute layer
  // (events/properties have their own surfaces) but `:` and `?` continue
  // through attribute-name validation.
  return false;
}

function isEventBinding(name: string): boolean {
  return name.startsWith("@");
}

function isPropertyBinding(name: string): boolean {
  return name.startsWith(".");
}

// Pull the literal members out of a CEM type.text like
//   "'small' | 'medium' | 'large'"
// or "'small'|'medium'". Returns null when the type isn't a string-literal
// union (so we never flag a value as invalid on a free-form string field).
export function extractEnumValues(typeText: string | undefined): string[] | null {
  if (!typeText) return null;
  const parts = typeText
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const values: string[] = [];
  for (const p of parts) {
    // 'small' or "small" → small
    const m = /^['"]([^'"]+)['"]$/.exec(p);
    if (!m) return null; // any non-literal member → not an enum we should police
    values.push(m[1]);
  }
  return values;
}

// Find every <tag ...> opening in the snippet. Returns the tag name (lowercased),
// the raw attribute text, and the 1-based line/column where the tag starts.
// Skips comments, CDATA, doctypes, and closing tags. Only looks at openings
// whose name contains a hyphen — those are the only possible custom elements,
// and we don't want to flag <div> or <input> as unknown.
interface ParsedTag {
  tag: string;
  attrsRaw: string;
  line: number;
  column: number;
}

function parseTags(snippet: string): ParsedTag[] {
  const out: ParsedTag[] = [];
  // Strip comments first so attribute-looking text inside them doesn't fool the parser.
  const cleaned = snippet.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const re = /<([a-z][a-z0-9-]*)(\s[^>]*?)?\s*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase();
    if (!tag.includes("-")) continue; // only custom elements
    const offset = m.index;
    const before = snippet.slice(0, offset);
    const line = (before.match(/\n/g)?.length ?? 0) + 1;
    const lastNl = before.lastIndexOf("\n");
    const column = offset - (lastNl + 1) + 1;
    out.push({ tag, attrsRaw: (m[2] ?? "").trim(), line, column });
  }
  return out;
}

// Pull attributes from the raw text between the tag name and the closing `>`.
// Handles: name="value", name='value', name=value (unquoted), and bare name
// (boolean). Returns attribute name lowercased.
interface ParsedAttr {
  name: string;
  value: string | null;
}

function parseAttrs(raw: string): ParsedAttr[] {
  const out: ParsedAttr[] = [];
  if (!raw) return out;
  const re = /([:@.?]?[a-z_][a-z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    if (name === "/") continue;
    const value =
      m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null;
    out.push({ name, value });
  }
  return out;
}

// Single-edit-distance "did you mean" for attribute and value typos. Cheap and
// targeted: we already know the candidate set is small (handful of attrs per
// tag, handful of values per enum). Skip noisy multi-edit suggestions.
function nearest(query: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(query.toLowerCase(), c.toLowerCase(), 2);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= 2 ? best : undefined;
}

// Capped Levenshtein — returns `cap + 1` as a "give up" sentinel when the
// real distance exceeds the cap. Plenty for "did you mean" on short strings.
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

export async function validateSnippet(
  registry: CemRegistry,
  snippet: string,
  options: { package?: string } = {},
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const parsed = parseTags(snippet);

  // Pre-load whichever packages we'll consult. When `package` is passed we only
  // validate against that one (its tags) and skip the rest; otherwise we'll
  // search across every discovered package.
  const candidatePackageNames = options.package
    ? registry.has(options.package)
      ? [options.package]
      : []
    : registry.packageNames();
  const loadedPackages = await Promise.all(candidatePackageNames.map((n) => registry.get(n)));

  // Tag → owning package + declaration. First wins; collisions are rare across
  // libraries because tag prefixes namespace things.
  const tagOwner = new Map<string, { pkg: string; decl: import("./cem.js").CemDeclaration }>();
  for (const pkg of loadedPackages) {
    for (const [tag, decl] of pkg.byTag) {
      if (!tagOwner.has(tag)) tagOwner.set(tag, { pkg: pkg.name, decl });
    }
  }

  let tagsValidated = 0;
  for (const t of parsed) {
    const owner = tagOwner.get(t.tag);
    if (!owner) {
      const suggestion = nearest(
        t.tag,
        Array.from(tagOwner.keys()).filter((k) => k.split("-")[0] === t.tag.split("-")[0]),
      );
      const scope = options.package ? ` in \`${options.package}\`` : "";
      issues.push({
        kind: "unknown-tag",
        tag: t.tag,
        message: `Unknown custom element \`<${t.tag}>\`${scope}.`,
        suggestion: suggestion ? `did you mean \`<${suggestion}>\`?` : undefined,
        line: t.line,
        column: t.column,
      });
      // We can still try did-you-mean for the package itself if it looks like
      // a prefix typo, but that's tangential — leave it to the explicit lookup.
      void suggestPackages;
      continue;
    }
    tagsValidated++;
    const attrs = parseAttrs(t.attrsRaw);
    const knownAttrs = owner.decl.attributes ?? [];
    const knownAttrNames = knownAttrs.map((a) => a.name);
    for (const a of attrs) {
      if (isGlobalAttr(a.name)) continue;
      // Event bindings (@click) and property bindings (.value) target different
      // surfaces than HTML attributes. Skip them at the attribute layer;
      // dedicated event/property validation is future work.
      if (isEventBinding(a.name) || isPropertyBinding(a.name)) continue;
      // Strip Vue attr-binding (`:`) and Lit boolean-attr (`?`) prefixes so
      // `:variant` and `?disabled` still validate as attribute names.
      const baseName = a.name.replace(/^[:?]/, "");
      const known = knownAttrs.find((k) => k.name === baseName);
      if (!known) {
        const suggestion = nearest(baseName, knownAttrNames);
        issues.push({
          kind: "unknown-attr",
          tag: t.tag,
          attr: a.name,
          message: `Unknown attribute \`${a.name}\` on \`<${t.tag}>\`.`,
          suggestion: suggestion ? `did you mean \`${suggestion}\`?` : undefined,
          line: t.line,
          column: t.column,
        });
        continue;
      }
      // Skip value validation when the binding prefix indicates a dynamic
      // value (`:foo="expr"`, `?foo=${x}`) — the actual value is an
      // expression and we can't enum-check it without running JS.
      if (/^[:?]/.test(a.name)) continue;
      if (a.value === null) continue;
      const enumValues = extractEnumValues(known.type?.text);
      if (!enumValues) continue;
      if (!enumValues.includes(a.value)) {
        const suggestion = nearest(a.value, enumValues);
        issues.push({
          kind: "invalid-value",
          tag: t.tag,
          attr: baseName,
          value: a.value,
          message: `Invalid value \`${a.value}\` for \`${baseName}\` on \`<${t.tag}>\`. Allowed: ${enumValues.map((v) => `\`${v}\``).join(", ")}.`,
          suggestion: suggestion ? `did you mean \`${suggestion}\`?` : undefined,
          line: t.line,
          column: t.column,
        });
      }
    }
  }

  return { tagsFound: parsed.length, tagsValidated, issues };
}

export function formatValidationResult(result: ValidationResult): string {
  const { tagsFound, tagsValidated, issues } = result;
  if (tagsFound === 0) {
    return "No custom element tags (containing a hyphen) found in the snippet.";
  }
  if (issues.length === 0) {
    return `# Validation: ok\nChecked ${tagsValidated}/${tagsFound} custom element tag${tagsFound === 1 ? "" : "s"}; no issues found.`;
  }
  const lines: string[] = [];
  lines.push(
    `# Validation: ${issues.length} issue${issues.length === 1 ? "" : "s"} (${tagsValidated}/${tagsFound} tags checked)`,
  );
  lines.push("");
  issues.forEach((i, n) => {
    const loc = `line ${i.line}, col ${i.column}`;
    const suffix = i.suggestion ? ` — ${i.suggestion}` : "";
    lines.push(`${n + 1}. [${i.kind}] ${i.message}${suffix} (${loc})`);
  });
  return lines.join("\n");
}
