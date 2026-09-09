# Changelog

## 0.2.1 — 2026-09-09

First npm-safe release.

- **Packaging fix**: bin entries now use `.js` shim files instead of `.ts`, fixing `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on Node 24 when installed via npm
- **npm publish workflow**: added `.github/workflows/publish.yml` with typecheck + pack gates and npm provenance
- **Install docs**: GitHub path remains primary; npm `baton-run` documented for post-publish use
- **npx safety**: all one-shot commands explicitly specify `--package=github:kanumuri9593/Baton` or `baton-run` to avoid conflicts with unrelated `baton`/`baton-mcp` packages on npm

> **Note**: Tag `v0.2.0` points at a commit with broken `.ts` bin entries. Use `v0.2.1` for npm installs.

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
