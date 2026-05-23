# ADR 0005 — Extensibility model: overlays, rule registry, config v2

- Status: Accepted
- Date: 2026-05-23
- Deciders: maintainer
- Replaces / replaced by: extends ADR-0001 and ADR-0002

## Context

cem-mcp already has two extension points: pluggable schema **adapters** (`cem2`, `carbon-html-data`) and a **config file** (`cem.config.json`) that controls discovery, paths, adapter selection, and global synonyms. That covers two real use cases:

1. A team's CEM lives outside `node_modules` — solved by `paths`.
2. A team's manifest follows a non-CEM shape — solved by adapters.

Three further use cases are unsolved today and require forking the package to address:

3. **The upstream CEM is missing data the team needs.** Examples are the most acute case (zero of the 9 audited libraries ship `@example` in their CEM, see ADR-0002 amendment), but the same applies to deprecation labels and usage notes ("when to use this component").
4. **The team has internal validation conventions** that aren't in CEM (e.g. "every `<acme-button>` in our codebase must declare `kind`").
5. **The team needs to silence a specific validation rule** that's noisy in their codebase (e.g. enum-value strictness when many values come from runtime config).

The natural shape — "augment the upstream CEM with a small declarative overlay, and toggle individual validation rules" — is not available. Without it, the only path is a fork, which loses every upstream update.

A fourth piece of context: Phase 1 of the post-1.1 roadmap (validate properties and event handlers, see ADR-0003) adds two more validation rules to a function that already hardcodes three. Without a registry, that function keeps growing as a series of `if/else` branches with no path to user-driven extension.

## Decision

Three coordinated additions, all declarative — no user-supplied JavaScript, no runtime `import()`.

### 1. Per-package overlays

A separate JSON file the user points at from `cem.config.json`. It **augments** the upstream CEM, never replaces it. The merge is layered: anything the overlay doesn't touch flows through from upstream, so an upstream version bump always wins for the fields the overlay didn't override.

```jsonc
// cem.config.json
{
  "packages": {
    "@acme/design-system": {
      "overlay": "./cem-overlays/acme.json",
    },
  },
}
```

```jsonc
// cem-overlays/acme.json
{
  "elements": {
    "acme-button": {
      "examples": ["<acme-button variant=\"primary\">Save</acme-button>"],
      "usage": "Always pair with `<acme-form-group>` for label/error UX.",
      "deprecated": {
        "attrs": { "type": "use `variant` instead" },
        "events": {},
        "properties": {},
      },
    },
  },
}
```

**Fields v1 supports.** `examples` (string array of HTML snippets), `usage` (short prose surfaced in compact view), `deprecated.attrs|events|properties` (map of name → replacement hint). The schema is strict — unknown keys are rejected at load time so typos surface immediately.

**Fields v1 deliberately does not support.** Renaming, removing, or retyping CEM-sourced fields. Overlays are additive only. Required-attr lists, per-component synonyms, and tag aliases are deferred until usage signals demand them — every field added to the overlay schema is a future maintenance burden, and we'd rather grow it on real demand than speculative.

**Load order.** Overlay is loaded once at registry construction, validated against its Zod schema, then merged into the in-memory `LoadedPackage` after the adapter parses the upstream CEM. Errors in overlay loading surface as startup-time warnings on stderr but do not block discovery — the package loads with the upstream CEM only.

### 2. Validation rule registry

`validateSnippet` becomes a thin driver that iterates over a registry of named rules. Each rule is a small object: `{ id, description, check }`. The three checks shipped in 1.1 (`unknown-tag`, `unknown-attr`, `invalid-value`) move into the registry with zero behavior change — same logic, same suggestions, same line/col, same tests pass unchanged.

```ts
export interface ValidationRule {
  id: string;
  description: string;
  check(ctx: RuleContext): ValidationIssue[];
}

export const BUILTIN_RULES: ValidationRule[] = [
  unknownTagRule,
  unknownAttrRule,
  invalidEnumValueRule,
  // ADR-0003 adds:
  unknownPropertyRule,
  unknownEventRule,
  // ADR-0005 adds, sourced from overlay:
  deprecatedFieldRule,
];
```

`RuleContext` carries the parsed tags, the loaded packages, the per-tag owning declaration, and helpers (`nearest`, `editDistance`) — everything a rule needs to produce zero or more `ValidationIssue` items.

**Config-level toggles.** Individual rules can be disabled:

```jsonc
{
  "validate": {
    "rules": { "disable": ["invalid-value"] },
  },
}
```

Disabled rules are skipped in the driver loop. The config validates that disabled IDs are real — typos surface as warnings. There is no "enable" inverse; the default is "all on."

**No user-supplied rules in v1.** Adding `rules: ['./my-rule.js']` would require `import()` from the project root, which is a real security surface (the MCP server runs in the user's shell, often with their credentials) and a real packaging mess (the rule module's own dependencies). Defer until there's evidence of demand the overlay schema can't satisfy.

### 3. Config schema v2 (backwards-compatible)

Today's per-package controls are split across three top-level keys: `paths`, `packages.include`, `packages.exclude`. The v2 schema unifies them under a per-package map while keeping the v1 keys valid:

```jsonc
{
  "packages": {
    "include": ["@acme/design-system"], // v1, still works
    "exclude": ["@deprecated/legacy"], // v1, still works
    "@acme/design-system": {
      "path": "./vendor/acme.json", // moved from top-level `paths`
      "overlay": "./cem-overlays/acme.json", // new
    },
  },
  "paths": { "@legacy/lib": "./old-path.json" }, // v1, still works
  "validate": { "rules": { "disable": [] } }, // new
}
```

**Migration story.** None required. Existing configs keep working untouched. The new per-package keys are additive. Internally, the loader merges v1 `paths` into the resolved per-package map so the rest of the code sees one consistent shape.

## Method

The three-feature scope was set by walking each unsolved use case and asking which extension primitive resolves it most cheaply.

- **Use case 3 (missing data).** Overlay only. Rule registry doesn't help — the data is what's missing, not the validation logic.
- **Use case 4 (custom validation conventions).** Best resolved by overlay (declare required attrs) + rule registry (a `required-attr` rule that reads the overlay). Deferred from v1 — see "what we deferred."
- **Use case 5 (silence a rule).** Rule registry config toggle. Trivial once the registry exists.
- **Phase 1 of the roadmap.** Rule registry, so prop/event checks register alongside the existing three rather than threading through more branches.

The decision to make overlays additive-only (no rename/remove/retype) came from two constraints: (a) the CEM is the ground truth — if upstream changes a type, the team needs to know, and a silent overlay override would hide that; (b) additive-only keeps the merge logic trivial and bounded, where partial replacement opens up edge cases ("what if the overlay's attr name conflicts with an existing attr's `fieldName`?") that aren't worth solving yet.

The decision to defer JS plugins came from comparing cost (eval surface, dependency hell, security review) to demand (zero asks today). Overlays + registry-toggles cover the cases we can name; rebuild the cost/benefit when someone hits a case they can't.

## Consequences

**Wins.** Teams with vendored CEMs can ship examples and deprecations without a fork. Phase 1 (and any future rule) plugs into a registry rather than growing `validateSnippet`. Config-level rule toggles let teams silence noise without disabling the whole validate tool. The overlay file format is small enough to copy-paste into an LLM and have it generate from internal docs.

**Costs.** Two new code surfaces to maintain: overlay schema + loader (~80 LOC), rule registry + driver migration (~100 LOC). The overlay schema is a public contract — adding fields is easy, removing or changing them is a breaking change. Strict schema validation at load time mitigates: typos in overlay files surface immediately, not silently.

**Risks to watch.** (a) Overlay schema bloat. Each new field is a permanent commitment. Guard rail: only add a field when we can name two real teams that would use it. (b) Rule registry vs. parser coupling. Rules can in principle reach into raw text and re-parse it, which would fragment the parser story. Guard rail: the `RuleContext` exposes only parsed structures, not raw text; if a rule needs more, it's a signal to extend `RuleContext`, not to bypass it. (c) Overlay drift. An overlay tied to a specific CEM version can rot when the upstream renames fields. Mitigation: log a warning at load time when an overlay's `deprecated.attrs[name]` references an attr that doesn't exist on the current CEM.

## What we learned

- **Extension axes split cleanly into "data we don't have" and "logic we want to run."** Overlays are the answer to the first; the rule registry is the answer to the second. Conflating them (e.g. "overlays that contain custom rules") would tangle two design problems that benefit from being kept separate.
- **JS plugins are tempting and almost never necessary at v1.** A declarative schema covers 80% of the cases the team can actually name; the remaining 20% are usually a sign that the schema is missing a primitive, not that we need eval.
- **Backward compatibility in config is cheap and worth doing.** Migration scripts have a maintenance cost; an additive schema with merged-internally semantics costs ~10 LOC at load time and zero ongoing cost.
