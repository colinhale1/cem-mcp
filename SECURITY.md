# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue in `cem-mcp`, please **do not
open a public issue**. Instead, report it privately via either:

- GitHub's [private vulnerability reporting](https://github.com/colinhale1/cem-mcp/security/advisories/new)
  (preferred), or
- email to `halecolin1@gmail.com` with subject prefix `[cem-mcp security]`.

We aim to acknowledge reports within 5 business days and to issue a fix
for confirmed issues within 30 days for high-severity findings.

## Threat model

`cem-mcp` runs locally on a developer's machine, reads JSON files from a
project's `node_modules`, and returns rendered markdown to an MCP client.
It does not execute manifest contents, does not make outbound network
requests, and does not modify files on disk. The realistic threat surface:

- **Maliciously crafted CEM JSON** in `node_modules` could attempt to
  exploit JSON parsing or our adapter code. Mitigation: we use the
  built-in `JSON.parse`, validate shape before use, and treat the
  resulting structure as untrusted data when rendering.
- **Path traversal via the `paths` field in `cem.config.json`** is bounded
  to the user's local filesystem; the server requires read access only.
- **Denial of service via a giant manifest**: discovery reads every
  candidate file into memory. The largest real-world manifest we've
  observed is ~2 MB. There is no hard size limit; processing scales
  linearly with manifest size.

If you find an attack vector outside these assumptions, please report it.

## Supply chain

The package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
attestations from GitHub Actions. Verify a release with:

```bash
npm audit signatures cem-mcp
```

Runtime dependencies are intentionally minimal: `@modelcontextprotocol/sdk`
and `zod`. Dev-only dependencies are pinned via `package-lock.json`.

## Supported versions

The latest published 1.x release receives security fixes. Older 0.x
pre-releases are not maintained.
