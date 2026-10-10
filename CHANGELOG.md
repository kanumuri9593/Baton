# Changelog

## 0.2.9 — 2026-10-10

Built for the loop a coding agent actually runs: edit, check, fix, check again.

- New `check_change` tool (and `baton check <session>`). One call applies an
  edit (hot reload for Flutter, HMR for web and React Native, restart for
  native and plain processes) and answers OK / NOT OK with only what is new
  since the call: the reload result, error lines, failed requests and a
  screenshot. It replaces five round trips per edit.
- Web screenshots. `screenshot` and `check_change` capture Vite, Next.js,
  Flutter web and any session with a URL in a throwaway headless Chrome,
  Edge or Brave (or `BATON_CHROME`). `viewport` takes `phone` (a true
  390×844 mobile layout, not Chrome's 500px minimum), `tablet`, `desktop`
  or `WIDTHxHEIGHT`. The page's console errors, uncaught exceptions and
  failed requests come back with the image, so an edit that leaves a blank
  page is reported, not passed. Web `run_proof` cells get screenshots too.
- New `boot_device` tool: boot an iOS simulator or Android emulator by name
  over MCP. With no name it lists what can boot.
- `wait_for` accepts up to 15 minutes (was 5), enough for a first native build.
- Every tool carries MCP hints (`readOnlyHint` / `destructiveHint`), so
  clients that honour them can stop asking before the 15 read-only tools.
- Stopping or restarting a web dev server now ends the whole process tree.
  Before, stopping `npm run dev` left Vite or Next.js running and holding
  the port, so the next restart failed with "port already in use".
- `set_debug_flag` sends parameter values as the strings Flutter's service
  extensions read (`enabled: "true"`).
- `npx -y baton-run` now starts the MCP server directly, and the package
  carries an MCP Registry listing (`server.json`, `mcpName`).
- New [docs/clients.md](docs/clients.md): copy-paste setup for Claude Code,
  Codex, Cursor, VS Code, Gemini CLI, Windsurf and Claude Desktop, plus a
  rules snippet that teaches any agent the loop.

## 0.2.8 — 2026-10-10

- The Claude Code plugin now shows Baton above the prompt. A band lists every
  live run (project, simulator or URL, status) with Reload all, and `/baton`
  opens a panel with each run's CPU and memory plus Reload, Restart,
  Screenshot and Stop. In the desktop app the panel shows the last screenshot.
  It reads the same daemon as the MCP tools, so runs started by Claude, the
  CLI or the Baton app all appear. Source: `plugins/baton/hooks/register.tsx`;
  CI runs its tests with `claude plugin test`.
- Running a target again after it stopped no longer fails with "already
  running on this device". A relaunch reuses the session id, and the stopped
  record now makes way for it instead of needing `forget_session` first.

## 0.2.7 — 2026-10-09

- `dist/instrumentation/node.mjs` now ships in the npm package. Before, any
  launch config with `"batonTrace": true` (including the workflow lab) failed
  with `ERR_MODULE_NOT_FOUND` when Baton was installed from npm or npx.
- `scripts/render-icons.mjs` resolves its own folder with `fileURLToPath`, so
  it works on Windows (it looked for `D:\D:\...`) and in paths with spaces.
  Windows CI is green again.
- Claude Code plugin in `plugins/baton`, with this repo as its marketplace:
  `/plugin marketplace add kanumuri9593/Baton` then `/plugin install baton@baton`.
  Bundles the `baton-mcp` server (pinned to the npm release), a `using-baton`
  skill, and `/baton:run` and `/baton:doctor`. CI validates the plugin and fails
  if its pinned version drifts from `package.json` (`scripts/check-plugin-version.mjs`).
- Removed committed `.superpowers/` brainstorm state and ignored it.

## 0.2.6 — 2026-09-09

- GitHub default branch is `main`. `master` stays fast-forwarded to the same
  commits so existing clones do not drift.
- Install docs, AGENTS.md, and the public site pin `#v0.2.6` (or
  `npm install -g baton-run`). Unpinned `github:kanumuri9593/Baton` follows
  `main`.
- GitHub Pages deploys from `main` as well as `master`.

## 0.2.5 — 2026-09-09

- HUD icon rasteriser passes a MIME type when drawing menu-bar template PNGs, so
  first launch no longer throws `TypeError: path argument ... undefined` and
  then swallows it. Menu-bar 18px/@2x files and `baton.icns` complete together.

## 0.2.4 — 2026-09-09

- Global git installs compile with the package's TypeScript dependency, so
  `npm install -g github:kanumuri9593/Baton` no longer fails looking for `tsc`.
- Cold `baton` / MCP auto-start spawn compiled `dist/daemon/main.js` instead of
  missing `main.ts`.
- HUD first launch ships `scripts/render-icons.mjs` and skips it when absent.
- Documented GitHub installs pin `#v0.2.4` so an unpinned default branch
  cannot still serve 0.2.0.

## 0.2.3 — 2026-09-09

- Folded the project list into the existing logo strip. There is no second
  side nav; collapse uses the same expand control.
- Collapsed rows show an iOS, Android, or web glyph, or the first letter of a
  workspace name.
- Centered stop, close, and inspect icons in their buttons.

## 0.2.2 — 2026-09-09

- Moved project switching into a collapsible side rail. Each project expands to
  its runs, and each run can be stopped or dismissed on its own.
- Workflow launches show as a workspace group so several projects started
  together stay visible as one unit, with per-step stop.
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
