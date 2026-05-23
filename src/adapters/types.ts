import type { CustomElementsManifest } from "../cem.js";

// Schema adapter: a small, declarative way to teach the server how to read a
// non-standard "custom-elements.json"-ish file. Discovery walks adapters in
// registration order; the first whose `matches()` returns true wins. The
// adapter then converts the source JSON into our internal CEM 2.x shape so
// the rest of the pipeline (indexing, search, formatting) is schema-agnostic.
//
// To add support for a new schema:
//   1. Create src/adapters/<name>.ts exporting a `CemAdapter`.
//   2. Add it to the `builtinAdapters` list in src/adapters/index.ts.
//   3. Optionally add a test case in test/adapters.test.ts.
//
// Adapters never throw on `matches()` — they're cheap shape checks against
// already-parsed JSON. `load()` may throw if the source is malformed; the
// error surfaces to the user as a discovery failure for that one package.
export interface CemAdapter {
  /** Stable identifier; surfaced in diagnostics and used by config to disable. */
  readonly name: string;
  /** Cheap shape check on parsed JSON. Must not throw. */
  matches(parsed: unknown): boolean;
  /** Convert the source JSON to CEM 2.x. May throw on malformed input. */
  load(parsed: unknown, sourcePath: string): CustomElementsManifest;
}
