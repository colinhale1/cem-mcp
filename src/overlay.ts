// Per-package overlay loader and merger. See docs/adr-0005-extensibility.md.
//
// Overlays augment the upstream CEM with data the CEM ecosystem doesn't ship
// today: usage examples, when-to-use prose, and deprecation labels. They are
// additive only — they never rename, remove, or retype CEM-sourced fields.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { LoadedPackage } from "./cem.js";

// Per-element overlay data. The schema is strict — unknown keys are rejected
// at load time so typos surface at startup instead of silently degrading.
const DeprecatedFieldsSchema = z
  .object({
    attrs: z.record(z.string()).optional(),
    events: z.record(z.string()).optional(),
    properties: z.record(z.string()).optional(),
  })
  .strict();

const OverlayElementSchema = z
  .object({
    examples: z.array(z.string().min(1)).optional(),
    usage: z.string().min(1).optional(),
    deprecated: DeprecatedFieldsSchema.optional(),
  })
  .strict();

const OverlayDocumentSchema = z
  .object({
    elements: z.record(OverlayElementSchema).optional(),
  })
  .strict();

export type OverlayElement = z.infer<typeof OverlayElementSchema>;
export type OverlayDocument = z.infer<typeof OverlayDocumentSchema>;

export interface LoadOverlayResult {
  document: OverlayDocument;
  sourcePath: string;
}

export async function loadOverlay(
  overlayPath: string,
  baseDir: string,
): Promise<LoadOverlayResult> {
  const resolved = isAbsolute(overlayPath) ? overlayPath : resolve(baseDir, overlayPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read overlay at ${resolved}: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }
  const parsed = OverlayDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid overlay at ${resolved}: ${parsed.error.message}`);
  }
  return { document: parsed.data, sourcePath: resolved };
}

// Attaches overlay data to matching declarations in the loaded package. Tags
// in the overlay that don't match a real declaration are reported in the
// returned `unmatched` array so the caller can warn — silently dropping them
// would hide overlay drift after an upstream rename.
export interface ApplyOverlayResult {
  matched: number;
  unmatched: string[];
}

export function applyOverlay(pkg: LoadedPackage, overlay: OverlayDocument): ApplyOverlayResult {
  const result: ApplyOverlayResult = { matched: 0, unmatched: [] };
  const elements = overlay.elements ?? {};
  for (const [tag, data] of Object.entries(elements)) {
    const decl = pkg.byTag.get(tag);
    if (!decl) {
      result.unmatched.push(tag);
      continue;
    }
    decl.overlay = data;
    result.matched++;
  }
  return result;
}
