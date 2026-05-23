# ADR 0003 — Validate properties and event handlers

- Status: Accepted
- Date: 2026-05-23
- Deciders: maintainer
- Replaces / replaced by: extends ADR-0002, builds on ADR-0005

## Context

ADR-0002 shipped `validate_component_usage` with three checks: unknown tag, unknown attribute, invalid enum value. An audit of the validation surface across the 9 bench libraries surfaced a real gap:

| Library                  | Prop-only members | Attr-only members |
| ------------------------ | ----------------: | ----------------: |
| @esri/calcite-components |               530 |                 0 |
| @cds/core                |               460 |                 0 |
| @carbon/web-components   |                 0 |              1374 |

"Prop-only" members are JavaScript properties with no matching HTML attribute — settable via `el.foo = …` imperatively or via Lit binding `.foo=${x}`, but never as `foo="..."` in HTML. Today's validator skips everything starting with `.`, so we silently accept arbitrary names there. Calcite alone has ~500 properties we don't validate.

Custom events are the same shape on the binding side: `@calciteComboboxChange="h"` in Lit/Vue templates targets the event list (`decl.events[]`), and we don't validate any of them today. Custom-event names are particularly hallucination-prone because the agent has to remember the exact casing (`calciteComboboxChange`, not `calciteCombobox-change` or `calcite-combobox-change`).

A third gap: when the agent uses the wrong _form_ for a known field — writes `complexObject="..."` for a prop-only member, or `.disabled=${x}` for an attr that has no matching property field — the current validator reports a generic "unknown" without telling the agent which form would have worked. The fix is mechanically derivable from CEM data (we know whether each name exists as attr, property, or both) and is the single highest-value error message we can produce.

## Decision

Extend `validate_component_usage` with three rules, registered against the rule registry from ADR-0005. No tool-schema change. No parser rewrite — the existing parser already captures the prefix character.

### Rule routing by prefix

The existing `parseAttrs` regex captures `[:@.?]` prefixes. The driver routes each parsed attribute to the appropriate rule by prefix:

| Prefix   | Binding kind          | Routed to rule                   | Value validation    |
| -------- | --------------------- | -------------------------------- | ------------------- |
| _(none)_ | HTML attribute        | `unknown-attr` + `invalid-value` | enum-checked        |
| `:`      | Vue attr-binding      | `unknown-attr`                   | skipped (dynamic)   |
| `?`      | Lit boolean-attr      | `unknown-attr`                   | skipped (dynamic)   |
| `.`      | Lit property-binding  | `unknown-property` (new)         | skipped (dynamic)   |
| `@`      | Lit/Vue event handler | `unknown-event` (new)            | n/a (handler ref)   |
| `on*`    | HTML event handler    | skipped                          | n/a (universal DOM) |

### New rule: `unknown-property`

Validates the name after `.` against `decl.members[]` filtered to `kind === "field"` and `privacy !== "private"` (and `!== "protected"` — both are agent-shouldn't-touch). Suggests via the same capped edit-distance helper used by `unknown-attr`.

### New rule: `unknown-event`

Validates the name after `@` against `decl.events[]`. Suggests via the same helper. Skips when the event name is a universal DOM event (`click`, `change`, `input`, `submit`, …) — those are valid on every element regardless of CEM declarations.

### New rule (cross-prefix hint): `wrong-binding-form`

When the agent uses `name="x"` (no prefix) for a prop-only member, or `.name=${x}` for an attr-only field with no matching property, surface a tailored message instead of the generic "unknown":

> `<calcite-combobox>` has no attribute `selectionMode`, but it does have a property — try `.selectionMode=${…}`.

> `<calcite-button>` has no property `kind`, but it does have an attribute — try `kind="..."`.

This is implemented as a fallback inside the `unknown-attr` and `unknown-property` rules rather than as a separate rule, because the issue's kind (`unknown-attr` vs `unknown-property`) is determined by the prefix the agent used; only the message and suggestion text change.

### Open question resolutions (from the planning conversation)

- **Q1 — Private/protected members.** Excluded from the candidate set _and_ from suggestions. Agents should not be reaching for them; surfacing them as did-you-mean would be a footgun.
- **Q2 — Same-name attr+prop.** Both forms (`disabled="..."` and `.disabled=${x}`) pass without warning. The cross-prefix hint only fires when one form exists and the other doesn't.
- **Q3 — Kebab in `.foo=`.** Rejected with a tailored message: `.complex-object` is invalid JS identifier syntax. Suggest the camelCase equivalent if `decl.members` contains a field whose name kebab-cases to the input.

## Method

The three new rules were chosen by walking the agent-error categories CEM data can mechanically detect:

1. _Misspelled property names_ — caught by `unknown-property` with did-you-mean.
2. _Misspelled event names_ — caught by `unknown-event` with did-you-mean.
3. _Wrong binding form for a known field_ — caught by the cross-prefix hint, which is the single most common confusion in mixed attr/prop libraries (Calcite, CDS).

Categories deliberately out of scope:

- _Property value type-checking_ (`.disabled=${"not-a-boolean"}`). Requires evaluating the expression. Defer indefinitely.
- _Event handler signature checking_ (does `h` actually take a `CalciteComboboxCustomEvent<…>`?). Requires TypeScript analysis. Out of MVP scope.
- _Lit template literal parsing_. Today the parser reads HTML-shaped substrings only. Adding template-literal parsing would let us validate inside `html\`…\`` tagged templates, but it's a sizeable parser project and most agent-written snippets are HTML-shaped or close to it. Defer.

## Consequences

**Wins.** Closes the ~500-prop-per-library gap that the MVP silently skipped. Custom-event hallucinations (a high-rate agent error in libraries with verbose event names) get a specific did-you-mean. The cross-prefix hint resolves the wrong-form-of-a-known-field case, which is currently a generic "unknown attr" with no path to a fix.

**Costs.** Three new rule modules; the existing parser handles the new prefixes for free. Test coverage grows by ~10 cases. Tool description stays the same length (the new rules surface the same kind of issue list as the existing three).

**Risks to watch.** (a) The universal-DOM-event allowlist for `@click` etc. is hand-maintained. If we miss one (e.g. a recent spec addition like `@toggle`), the agent gets a false-positive "unknown event." Keep the allowlist conservative; prefer false negatives. (b) Some libraries don't model events fully in their CEM (events shipped as `MouseEvent` rather than a named custom event). For those, `unknown-event` is too strict. Mitigation: when `decl.events` is empty for a tag that's otherwise well-declared, only flag `@`-prefixed handlers that contain the package's known prefix (e.g. `@calciteFoo`); pass through everything else as a probable native event.

## What we learned

- **The rule-registry shape pays for itself the first time you add a rule.** Phase 1 adds three rules with ~30 LOC each plus a few lines in the registry — versus ~120 LOC of branched logic in `validateSnippet` without the registry. The migration from ADR-0005 isn't speculative; it's the substrate Phase 1 needed anyway.
- **Cross-prefix hints are higher leverage than first-prefix hints.** The agent is more likely to know "I want `disabled`" than to know "I want `disabled` as a property, not an attribute." Pointing at the right form when the wrong one was used eliminates a class of stuck states that pure "unknown" errors don't resolve.
