# Changelog

## 0.2.1 — 2026-09-09

First npm-publishable release.

- **Build system**: Added esbuild compilation step (`npm run build`) that bundles TypeScript to `dist/*.js` for npm distribution
- **Bin entries**: Now point to compiled `dist/cli.js`, `dist/daemon.js`, `dist/mcp.js` instead of `.ts` imports
- **Node 24 fix**: Resolves `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when installed via npm — Node refuses to strip types from packages inside `node_modules/`
- **npm publish workflow**: Added `.github/workflows/publish.yml` with typecheck + pack gates and npm provenance
- **npx safety**: All documented one-shot commands use explicit `--package=` to avoid conflicts with unrelated `baton`/`baton-mcp` packages on npm

> **Note**: Tag `v0.2.0` has broken bin entries that fail on Node 24. Use `v0.2.1` for npm installs.

## 0.2.0 — 2026-09-08

Public developer preview.

- Multi-project workflows (`baton workflow`, MCP `run_workflow`)
- Guided project inspection (`baton doctor`, MCP `inspect_project`)
- Cross-session diagnose and optional Node OpenTelemetry tracing
- Credential-free Flutter and two-project delivery labs
- MCP, CLI, and HUD documented for third-party agent installs
- Version branded as **Baton** 0.2.0 (`baton-run` on npm)

## 0.1.0

Initial Baton: launch.json / package.json / Flutter detection, daemon, HUD, MCP, devices, checkouts, proofs.
