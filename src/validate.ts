// HTML snippet validator for web components. Parses <tag attr="value"> usage
// patterns and runs a set of validation rules against the loaded CEM
// registry. See docs/adr-0002-tool-shape.md for the original scope and
// docs/adr-0005-extensibility.md for the rule-registry refactor.

import type { CemDeclaration, CemRegistry } from "./cem.js";

export type ValidationIssueKind = "unknown-tag" | "unknown-attr" | "invalid-value";

export interface ValidationIssue {
  kind: ValidationIssueKind;
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

// --- shared helpers --------------------------------------------------------

// Standard HTML global attributes we never flag as unknown, even when they
// don't appear in the CEM. ARIA / data-* / event handlers are handled by
// prefix checks below.
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
  "ref",
  "key",
]);

function isGlobalAttr(name: string): boolean {
  if (GLOBAL_ATTRS.has(name)) return true;
  if (name.startsWith("data-")) return true;
  if (name.startsWith("aria-")) return true;
  if (name.startsWith("on")) return true; // onclick, onfoo-bar, etc.
  return false;
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
    const m = /^['"]([^'"]+)['"]$/.exec(p);
    if (!m) return null; // any non-literal member → not an enum we should police
    values.push(m[1]);
  }
  return values;
}

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
// targeted: candidate sets are small (handful of attrs per tag, handful of
// values per enum). Capped Levenshtein with a `cap + 1` "give up" sentinel.
export function nearest(query: string, candidates: string[], cap = 2): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(query.toLowerCase(), c.toLowerCase(), cap);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= cap ? best : undefined;
}

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

// --- rule registry ---------------------------------------------------------

export interface TagOwner {
  pkg: string;
  decl: CemDeclaration;
}

// The shared state every rule operates against. The driver builds this once
// and passes it to each enabled rule.
export interface RuleContext {
  parsedTags: ParsedTag[];
  tagOwner: Map<string, TagOwner>;
  // True when validation was scoped to a single package via the tool's
  // `package` parameter. Affects error wording ("in `pkg`") and shrinks the
  // candidate set for did-you-mean.
  scopedPackage?: string;
}

export interface ValidationRule {
  id: string;
  description: string;
  check(ctx: RuleContext): ValidationIssue[];
}

// Rule 1 — flags any parsed tag that no loaded package declares. Did-you-mean
// is filtered to tags sharing the same prefix (e.g. typos within `sl-*`).
export const unknownTagRule: ValidationRule = {
  id: "unknown-tag",
  description: "Custom element tag is not declared by any loaded CEM.",
  check(ctx) {
    const issues: ValidationIssue[] = [];
    const allTags = Array.from(ctx.tagOwner.keys());
    for (const t of ctx.parsedTags) {
      if (ctx.tagOwner.has(t.tag)) continue;
      const samePrefix = allTags.filter((k) => k.split("-")[0] === t.tag.split("-")[0]);
      const suggestion = nearest(t.tag, samePrefix);
      const scope = ctx.scopedPackage ? ` in \`${ctx.scopedPackage}\`` : "";
      issues.push({
        kind: "unknown-tag",
        tag: t.tag,
        message: `Unknown custom element \`<${t.tag}>\`${scope}.`,
        suggestion: suggestion ? `did you mean \`<${suggestion}>\`?` : undefined,
        line: t.line,
        column: t.column,
      });
    }
    return issues;
  },
};

// Rule 2 — for each known tag, flags attributes that aren't declared on it.
// Skips standard globals, event/property bindings (those have their own
// rules, future work), and pure dynamic-value markers. `:` and `?` prefixes
// are stripped so `:variant` and `?disabled` validate as `variant` and
// `disabled` respectively.
export const unknownAttrRule: ValidationRule = {
  id: "unknown-attr",
  description: "Attribute is not declared on this tag.",
  check(ctx) {
    const issues: ValidationIssue[] = [];
    for (const t of ctx.parsedTags) {
      const owner = ctx.tagOwner.get(t.tag);
      if (!owner) continue;
      const attrs = parseAttrs(t.attrsRaw);
      const knownAttrs = owner.decl.attributes ?? [];
      const knownAttrNames = knownAttrs.map((a) => a.name);
      for (const a of attrs) {
        if (isGlobalAttr(a.name)) continue;
        if (a.name.startsWith("@") || a.name.startsWith(".")) continue;
        const baseName = a.name.replace(/^[:?]/, "");
        if (knownAttrs.find((k) => k.name === baseName)) continue;
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
      }
    }
    return issues;
  },
};

// Rule 3 — for known attributes whose type is a string-literal union, flags
// values that aren't in the union. Skips dynamic bindings (the value is an
// expression and we can't evaluate it).
export const invalidEnumValueRule: ValidationRule = {
  id: "invalid-value",
  description: "Attribute value is outside the declared enum union.",
  check(ctx) {
    const issues: ValidationIssue[] = [];
    for (const t of ctx.parsedTags) {
      const owner = ctx.tagOwner.get(t.tag);
      if (!owner) continue;
      const attrs = parseAttrs(t.attrsRaw);
      const knownAttrs = owner.decl.attributes ?? [];
      for (const a of attrs) {
        if (isGlobalAttr(a.name)) continue;
        if (a.name.startsWith("@") || a.name.startsWith(".")) continue;
        if (/^[:?]/.test(a.name)) continue; // dynamic binding — skip value check
        if (a.value === null) continue;
        const baseName = a.name.replace(/^[:?]/, "");
        const known = knownAttrs.find((k) => k.name === baseName);
        if (!known) continue; // unknown-attr handles the missing case
        const enumValues = extractEnumValues(known.type?.text);
        if (!enumValues) continue;
        if (enumValues.includes(a.value)) continue;
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
    return issues;
  },
};

export const BUILTIN_RULES: ReadonlyArray<ValidationRule> = [
  unknownTagRule,
  unknownAttrRule,
  invalidEnumValueRule,
];

// --- driver ----------------------------------------------------------------

export async function validateSnippet(
  registry: CemRegistry,
  snippet: string,
  options: { package?: string } = {},
): Promise<ValidationResult> {
  const parsedTags = parseTags(snippet);

  // Pre-load whichever packages we'll consult. When `package` is passed we only
  // validate against that one's tags; otherwise we search across every
  // discovered package.
  const candidatePackageNames = options.package
    ? registry.has(options.package)
      ? [options.package]
      : []
    : registry.packageNames();
  const loadedPackages = await Promise.all(candidatePackageNames.map((n) => registry.get(n)));

  // Tag → owning package + declaration. First wins; collisions are rare across
  // libraries because tag prefixes namespace things.
  const tagOwner = new Map<string, TagOwner>();
  for (const pkg of loadedPackages) {
    for (const [tag, decl] of pkg.byTag) {
      if (!tagOwner.has(tag)) tagOwner.set(tag, { pkg: pkg.name, decl });
    }
  }

  const ctx: RuleContext = { parsedTags, tagOwner, scopedPackage: options.package };

  const disabled = new Set(registry.config.config.validate?.rules?.disable ?? []);
  const issues: ValidationIssue[] = [];
  for (const rule of BUILTIN_RULES) {
    if (disabled.has(rule.id)) continue;
    issues.push(...rule.check(ctx));
  }

  // Sort issues into document order. Each rule walks tags top-to-bottom, but
  // across rules the order would be rule-grouped (all unknown-tag, then all
  // unknown-attr, ...). Sorting restores the per-tag ordering callers expect.
  issues.sort((a, b) => a.line - b.line || a.column - b.column);

  const tagsValidated = parsedTags.filter((t) => tagOwner.has(t.tag)).length;
  return { tagsFound: parsedTags.length, tagsValidated, issues };
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
