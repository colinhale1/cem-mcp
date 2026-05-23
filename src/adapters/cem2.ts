import type { CustomElementsManifest } from "../cem.js";
import type { CemAdapter } from "./types.js";

// Identity adapter for the standard Custom Elements Manifest 2.x schema.
// Covers anything published with @custom-elements-manifest/analyzer, Stencil
// (which writes CEM 2.x to dist/docs/api.json), and most Lit-based libraries.
export const cem2Adapter: CemAdapter = {
  name: "cem2",
  matches(parsed): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const o = parsed as { modules?: unknown };
    return Array.isArray(o.modules);
  },
  load(parsed): CustomElementsManifest {
    return parsed as CustomElementsManifest;
  },
};
