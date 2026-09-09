# Changelog

## Unreleased

- Added a persistent Settings surface with system/light/dark themes, reduced
  motion, startup view, last-project restoration, and Stop-all confirmation.
- Added native macOS preferences for keeping the expanded control panel on top
  and launching Baton at login.
- Added `baton app` as the primary control-panel command; `baton hud` remains a
  backward-compatible alias.
- Native iOS and Android folders and project files are recognised when adding a
  project. Run builds, installs and launches on the selected simulator or
  device, then follows logs. Restart rebuilds and relaunches. There is still no
  hot reload.
- Restored the complete test suite as an npm publish gate and documented the
  system architecture and preference storage.

## 0.2.1 — 2026-09-09

First npm publish of `baton-run`.

- **Fix:** Bin shims now import compiled JS from `dist/` instead of raw `.ts` from `src/`, fixing `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when installed via npm on Node 24+
- Build step added: `npm run build` compiles TypeScript to `dist/` before publish
- Install via `npm install -g baton-run` now works correctly

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
