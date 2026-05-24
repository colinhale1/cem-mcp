// HTML snippet validator for web components. Parses <tag attr="value"> usage
// patterns and runs a set of validation rules against the loaded CEM
// registry. See docs/adr-0002-tool-shape.md for the original scope,
// docs/adr-0005-extensibility.md for the rule-registry refactor, and
// docs/adr-0003-validate-props-events.md for property/event/deprecation
// coverage.

import type { CemDeclaration, CemMember, CemRegistry } from "./cem.js";

export type ValidationIssueKind =
  | "unknown-tag"
  | "unknown-attr"
  | "unknown-property"
  | "unknown-event"
  | "invalid-value"
  | "deprecated-field";

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

// Two branches: the prefixed form (handles `:foo`, `?foo`, `@foo`, plus
// `@foo.modifier.modifier` from Vue templates) and the bare-dot form
// (`.foo` Lit property bindings). Bare-name attrs (`disabled`) fall under
// the first branch with an empty prefix.
const ATTR_RE =
  /([:@?]?[a-z_][a-z0-9_-]*(?:\.[a-z0-9_-]+)*|\.[a-z_][a-z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;

function parseAttrs(raw: string): ParsedAttr[] {
  const out: ParsedAttr[] = [];
  if (!raw) return out;
  // Reset regex state — global regexes are stateful in JS.
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const rawName = m[1];
    if (rawName === "/") continue;
    // HTML attribute names are case-insensitive (lowercase per spec). JS
    // property bindings (`.foo=`) and DOM event handler names (`@foo=`)
    // are case-sensitive. Preserve case for the prefixed forms so we can
    // match camelCase fields and custom-event names declared in the CEM.
    const name =
      rawName.startsWith(".") || rawName.startsWith("@") ? rawName : rawName.toLowerCase();
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

// --- binding & member helpers ---------------------------------------------

// Universal DOM events agents legitimately bind to with `@foo` on any element,
// including custom elements. Kept conservative: an event present here is
// passed through without checking the component's `events[]` list. Per
// ADR-0003 risk note: prefer false negatives (missed custom-event flags)
// over false positives (rejecting valid native bindings).
const NATIVE_EVENTS = new Set([
  // Mouse
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "mousemove",
  "contextmenu",
  "wheel",
  // Keyboard
  "keydown",
  "keyup",
  "keypress",
  // Focus
  "focus",
  "blur",
  "focusin",
  "focusout",
  // Form
  "input",
  "beforeinput",
  "change",
  "submit",
  "reset",
  "select",
  "invalid",
  // Pointer
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerenter",
  "pointerleave",
  "pointerover",
  "pointerout",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  // Touch
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  // Drag
  "drag",
  "dragstart",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
  // Clipboard
  "copy",
  "cut",
  "paste",
  // Scroll / view
  "scroll",
  "scrollend",
  "resize",
  // Composition / IME
  "compositionstart",
  "compositionupdate",
  "compositionend",
  // Animation / transition
  "animationstart",
  "animationend",
  "animationiteration",
  "transitionstart",
  "transitionend",
  "transitionrun",
  "transitioncancel",
  // Lifecycle / network
  "load",
  "unload",
  "beforeunload",
  "pagehide",
  "pageshow",
  "error",
  "abort",
  "loadstart",
  "loadend",
  // Media (custom elements often wrap audio/video)
  "play",
  "pause",
  "ended",
  "timeupdate",
  "volumechange",
  "durationchange",
  "canplay",
  "canplaythrough",
  "seeking",
  "seeked",
  "waiting",
  "stalled",
  "ratechange",
  "progress",
  // Disclosure / dialog
  "toggle",
  "beforetoggle",
  "close",
  "cancel",
  "show",
  // Fullscreen
  "fullscreenchange",
  "fullscreenerror",
  // Generic
  "message",
  "messageerror",
]);

// Returns the public field members of a declaration — the candidate set for
// `.foo=` property-binding validation. Private and protected members are
// excluded both from the candidate set and from did-you-mean suggestions.
function publicFields(decl: CemDeclaration): CemMember[] {
  return (decl.members ?? []).filter(
    (m) => m.kind === "field" && m.privacy !== "private" && m.privacy !== "protected",
  );
}

// CEM convention: an attribute may carry `fieldName` pointing at the JS
// property that backs it (e.g. attr `selection-mode` → field `selectionMode`).
// Both names should be considered "this name maps to a known field" when
// asking the cross-prefix question.
function hasMatchingAttributeForName(decl: CemDeclaration, name: string): boolean {
  const attrs = decl.attributes ?? [];
  return attrs.some((a) => a.name === name || a.fieldName === name);
}

function hasMatchingPropertyForName(decl: CemDeclaration, name: string): boolean {
  return publicFields(decl).some((p) => p.name === name);
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// Strips Vue/Lit modifiers like `.stop`, `.prevent`, `.capture` from an
// `@event.modifier` token. Idempotent on names with no modifiers.
function stripEventModifiers(name: string): string {
  const dot = name.indexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
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
// Skips standard globals, event/property bindings (handled by their own
// rules), and on* event handlers. Emits a tailored cross-prefix hint when
// the unknown attribute name matches a known property (agent used `foo="x"`
// for a prop-only member). See ADR-0003.
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
        // Property/event bindings have their own rules.
        if (a.name.startsWith("@") || a.name.startsWith(".")) continue;
        const baseName = a.name.replace(/^[:?]/, "");
        if (knownAttrs.find((k) => k.name === baseName)) continue;
        // Cross-prefix hint — the agent typed an attribute, but the name
        // matches a known JS property with no corresponding HTML attribute.
        // Suggest the property-binding form instead of the generic "unknown".
        if (hasMatchingPropertyForName(owner.decl, baseName)) {
          issues.push({
            kind: "unknown-attr",
            tag: t.tag,
            attr: a.name,
            message: `\`<${t.tag}>\` has no attribute \`${baseName}\`, but it does have a property — try \`.${baseName}=\${…}\`.`,
            line: t.line,
            column: t.column,
          });
          continue;
        }
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

// Rule 4 (new) — flags `.foo=` property bindings whose name isn't a public
// field on the tag's declaration. Three sub-cases:
//   - kebab-cased property binding (`.complex-object=`) → invalid JS
//     identifier; suggest the camelCase form if it exists on the decl.
//   - name matches a known attribute (no property of that name) → suggest the
//     attribute form (cross-prefix hint).
//   - otherwise → standard did-you-mean against the public field list.
export const unknownPropertyRule: ValidationRule = {
  id: "unknown-property",
  description: "Property binding (`.foo=`) targets a name that's not a public field.",
  check(ctx) {
    const issues: ValidationIssue[] = [];
    for (const t of ctx.parsedTags) {
      const owner = ctx.tagOwner.get(t.tag);
      if (!owner) continue;
      const attrs = parseAttrs(t.attrsRaw);
      for (const a of attrs) {
        if (!a.name.startsWith(".")) continue;
        const propName = a.name.slice(1); // strip leading "."
        const fields = publicFields(owner.decl);
        const fieldNames = fields.map((f) => f.name);

        // Already valid — nothing to flag.
        if (fields.some((f) => f.name === propName)) continue;

        // Kebab-in-property — invalid JS identifier syntax. Suggest camelCase.
        if (propName.includes("-")) {
          const camel = kebabToCamel(propName);
          const match = fields.some((f) => f.name === camel);
          const suggestion = match
            ? `property bindings use camelCase — try \`.${camel}=\${…}\``
            : undefined;
          issues.push({
            kind: "unknown-property",
            tag: t.tag,
            attr: a.name,
            message: `Property binding \`${a.name}\` uses kebab-case; properties are camelCase JS identifiers.`,
            suggestion,
            line: t.line,
            column: t.column,
          });
          continue;
        }

        // Cross-prefix hint — agent used `.foo=` for a name that's only an
        // attribute on this element. Suggest the attribute form.
        if (hasMatchingAttributeForName(owner.decl, propName)) {
          issues.push({
            kind: "unknown-property",
            tag: t.tag,
            attr: a.name,
            message: `\`<${t.tag}>\` has no property \`${propName}\`, but it does have an attribute — try \`${propName}="…"\`.`,
            line: t.line,
            column: t.column,
          });
          continue;
        }

        const suggestion = nearest(propName, fieldNames);
        issues.push({
          kind: "unknown-property",
          tag: t.tag,
          attr: a.name,
          message: `Unknown property \`${a.name}\` on \`<${t.tag}>\`.`,
          suggestion: suggestion ? `did you mean \`.${suggestion}\`?` : undefined,
          line: t.line,
          column: t.column,
        });
      }
    }
    return issues;
  },
};

// Rule 5 (new) — flags `@foo=` event-handler bindings whose name isn't a
// declared event on the tag and isn't a universal native DOM event. Strips
// Vue/Lit modifiers (`@click.stop` → checks `click`).
export const unknownEventRule: ValidationRule = {
  id: "unknown-event",
  description: "Event handler (`@foo=`) targets a name not declared by the component.",
  check(ctx) {
    const issues: ValidationIssue[] = [];
    for (const t of ctx.parsedTags) {
      const owner = ctx.tagOwner.get(t.tag);
      if (!owner) continue;
      const events = owner.decl.events ?? [];
      const eventNames = events.map((e) => e.name);
      const attrs = parseAttrs(t.attrsRaw);
      for (const a of attrs) {
        if (!a.name.startsWith("@")) continue;
        const eventName = stripEventModifiers(a.name.slice(1));
        if (!eventName) continue;
        // Native DOM events match case-insensitively (HTML and the DOM are
        // case-insensitive for native event names).
        if (NATIVE_EVENTS.has(eventName.toLowerCase())) continue;
        // Custom events declared in CEM are typically camelCase (calciteFoo,
        // sl-foo, etc.). Lowercase both sides so an agent that mis-casts is
        // accepted (the addEventListener call works either way in the
        // browser).
        const lookupName = eventName.toLowerCase();
        if (events.some((e) => e.name.toLowerCase() === lookupName)) continue;
        const suggestion = nearest(eventName, eventNames);
        issues.push({
          kind: "unknown-event",
          tag: t.tag,
          attr: a.name,
          message: `Unknown event \`${a.name}\` on \`<${t.tag}>\`. Component declares ${eventNames.length} event${eventNames.length === 1 ? "" : "s"}.`,
          suggestion: suggestion ? `did you mean \`@${suggestion}\`?` : undefined,
          line: t.line,
          column: t.column,
        });
      }
    }
    return issues;
  },
};

// Rule 6 (new) — flags usage of any attr/event/property whose name appears in
// the overlay's `deprecated.*` map. The overlay value carries the suggested
// replacement, which is surfaced verbatim in the issue's `suggestion` slot.
export const deprecatedFieldRule: ValidationRule = {
  id: "deprecated-field",
  description: "Field is marked deprecated by the package overlay.",
  check(ctx) {
    const issues: ValidationIssue[] = [];
    for (const t of ctx.parsedTags) {
      const owner = ctx.tagOwner.get(t.tag);
      if (!owner) continue;
      const deprecated = owner.decl.overlay?.deprecated;
      if (!deprecated) continue;
      const attrs = parseAttrs(t.attrsRaw);
      for (const a of attrs) {
        let kind: "attrs" | "events" | "properties";
        let lookupName: string;
        if (a.name.startsWith("@")) {
          kind = "events";
          lookupName = stripEventModifiers(a.name.slice(1));
        } else if (a.name.startsWith(".")) {
          kind = "properties";
          lookupName = a.name.slice(1);
        } else {
          kind = "attrs";
          lookupName = a.name.replace(/^[:?]/, "");
        }
        const replacement = deprecated[kind]?.[lookupName];
        if (replacement === undefined) continue;
        // Use the kind plural's singular noun in the message for readability.
        const noun = kind === "attrs" ? "attribute" : kind === "events" ? "event" : "property";
        issues.push({
          kind: "deprecated-field",
          tag: t.tag,
          attr: a.name,
          message: `Deprecated ${noun} \`${lookupName}\` on \`<${t.tag}>\`.`,
          suggestion: replacement,
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
  unknownPropertyRule,
  unknownEventRule,
  invalidEnumValueRule,
  deprecatedFieldRule,
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
