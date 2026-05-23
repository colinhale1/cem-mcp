// Flat config (ESLint 9+). Keeps rules minimal — we want a baseline of
// correctness checks and consistency without nagging on every paragraph of
// expressive code. Anything stronger should be added when there's a concrete
// reason; defaults that just slow contributors down get dropped.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Node globals used throughout — declared once so .mjs scripts (which don't
// go through TypeScript and so don't pick up @types/node) lint cleanly.
const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  performance: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "test/fixtures/**",
      ".tmp/**",
      "coverage/**",
      "**/.tmp-*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts", "**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      // Allow leading-underscore for intentionally unused params/vars.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The adapter system and CEM parsing both legitimately deal with
      // unknown-shaped JSON; explicit `any` at boundaries is fine. We still
      // warn so it stays a deliberate choice.
      "@typescript-eslint/no-explicit-any": "warn",
      // Non-null assertions get used on Map.get / find paths where the
      // surrounding code has already guaranteed the value exists. Warn, don't
      // fail the build.
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    files: ["scripts/**/*.mjs", "bench/**/*.ts"],
    rules: {
      // Scripts and bench harnesses use console for their actual output;
      // that's the point.
      "no-console": "off",
    },
  },
  // Must come last to disable rules that conflict with Prettier formatting.
  prettier,
];
