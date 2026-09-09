<p align="center">
  <img src="assets/baton.svg" width="88" alt="Baton">
</p>

<h1 align="center">Baton</h1>

<p align="center">
  <strong>The local run control plane for people and coding agents.</strong><br>
  Run, hot-reload, boot simulators, and capture evidence for Flutter, Next.js, Vite, and React Native from a terminal, the Baton app, or any MCP-compatible agent.
</p>

<p align="center">
  <a href="https://github.com/kanumuri9593/Baton/blob/master/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0ea5e9"></a>
  <a href="https://github.com/kanumuri9593/Baton/releases/tag/v0.2.1"><img alt="Version 0.2.1" src="https://img.shields.io/badge/version-0.2.1-111827"></a>
  <a href="https://nodejs.org/"><img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-339933"></a>
  <a href="https://modelcontextprotocol.io/"><img alt="MCP server" src="https://img.shields.io/badge/MCP-baton--mcp-7c3aed"></a>
</p>

```bash
npm install -g github:kanumuri9593/Baton
baton app
```

## The Problem

Developers increasingly ask coding agents to run `npm start`, watch a terminal, wait for a port, read logs, restart a process, or take a screenshot. Those are deterministic computer tasks, yet every terminal command, poll, and pasted log consumes model tokens, time, and money. The agent becomes an expensive shell wrapper.

Meanwhile, if the only reason you keep an IDE open is its Run & Debug toolbar — the config picker, the ⟳ ⟲ ■ buttons, three simulators at once — that's what Baton replaces. And it adds what an IDE can't give you: **your agent can press the same buttons.**

```bash
baton list                                  # what can I run here?
baton run "iOS Simulator (DEV)"
baton run "iOS Simulator (DEV)" --branch origin/main
baton reload --all                          # hot reload every session
baton boot "iPhone 17 Pro Max"              # start a simulator that isn't running
baton add ~/code/storefront                 # watch another project too
baton app                                   # floating launcher + full control panel
```

---

## Get it

| Way | Command |
|---|---|
| **GitHub** | `npm install -g github:kanumuri9593/Baton` |
| **One-shot CLI** | `npx -y --package=github:kanumuri9593/Baton baton list` |
| **One-shot MCP** | `npx -y --package=github:kanumuri9593/Baton baton-mcp` |
| **npm** (after v0.2.1 is published) | `npm install -g baton-run` |
| **Clone** | `git clone https://github.com/kanumuri9593/Baton.git && cd Baton && npm install && npm run build` |
| **Baton app** | After install: `baton app` — native floating launcher + control panel on macOS; app-style browser window on Linux/Windows. `baton hud` remains an alias. |
| **Source tarball** | [Releases](https://github.com/kanumuri9593/Baton/releases) |

Requires **Node.js 24+**. macOS, Linux, and Windows.

| Method | Command |
|---|---|
| **GitHub** | `npm install -g github:kanumuri9593/Baton` |
| **npm** (404 until published) | `npm install -g baton-run` — not yet on registry |
| **One-shot CLI** | `npx -y --package=github:kanumuri9593/Baton baton list` |
| **One-shot MCP** | `npx -y --package=github:kanumuri9593/Baton baton-mcp` |
| **Clone** | `git clone https://github.com/kanumuri9593/Baton.git && cd Baton && npm install && npm run build` |
| **HUD / UI** | After install: `baton hud` — native floating panel + menu bar on macOS; chromeless browser window on Linux/Windows. |
| **Source tarball** | [Releases](https://github.com/kanumuri9593/Baton/releases) |

Pin a release:

```bash
npm install -g github:kanumuri9593/Baton#v0.2.1
```

### The Baton app

There is **no App Store download** — open Baton with `baton app`:

- **macOS**: native floating launcher, full control panel, Dock and menu-bar access. First run compiles the small AppKit host from `hud/` (needs Xcode or Command Line Tools).
- **Linux / Windows**: the same control panel in an app-style browser window.

First launch may take a few seconds while the panel compiles.

### Troubleshooting

**ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING** — If you installed an old `baton-run@0.2.0` that tried to import `.ts` files directly:

```bash
npm uninstall -g baton-run
npm install -g github:kanumuri9593/Baton   # or wait for baton-run@0.2.1+ on npm
```

---

## Connect any agent

Baton is an MCP server. Any compatible agent gets structured tools instead of scraping `flutter run` output. Scripts can use the same `baton` CLI; every command exits non-zero on failure.

Full agent notes: **[AGENTS.md](AGENTS.md)**. Crawler-friendly summary: **[llms.txt](llms.txt)**.

Use this with any client that accepts an MCP server configuration:

```json
{
  "mcpServers": {
    "baton": { "command": "baton-mcp" }
  }
}
```

Without a global install:

```json
{
  "mcpServers": {
    "baton": {
      "command": "npx",
      "args": ["-y", "--package=github:kanumuri9593/Baton", "baton-mcp"]
    }
  }
}
```

Full agent notes: **[AGENTS.md](AGENTS.md)** · Crawler-friendly summary: **[llms.txt](llms.txt)**

---

## MCP Tools

| Tool | Description |
|---|---|
| `inspect_project` | Discover targets, devices, and capabilities |
| `list_targets` | Available run configurations |
| `run_target` / `run_workflow` | Start apps, optionally from a branch |
| `hot_reload` / `hot_restart` | Update running sessions |
| `wait_for` | Block until ready (no polling) |
| `read_logs` / `session_summary` | Structured output, not terminal scraping |
| `screenshot` | Capture evidence |
| `diagnose` | Cross-session error search |
| `list_devices` / `boot` | Simulator management |

**Typical loop:** `inspect_project` → `run_target` → `wait_for` → exercise the app → `screenshot` / `read_logs` → edit → `hot_reload`

Failed reloads return the actual compiler error, not just "DevFS synchronization failed":

```
lib/main.dart:419:19: Error: Expected ';' after this.
```

That's the difference between an agent that can fix its own mistake and one that's stuck.

---

## Framework Support

| Framework | Hot Reload | Restart | Notes |
|---|---|---|---|
| **Flutter / Dart** | ✅ Real (daemon protocol) | ✅ Hot restart | Devices, DevTools, debug flags, screenshots |
| **Next.js, Vite, Nuxt, Astro, Remix** | HMR on save | ✅ Dev server | Detects real URL and readiness |
| **React Native / Expo** | Fast Refresh | ✅ Reload broadcast | Metro message socket |
| **Anything else** | — | ✅ Kill/respawn | Any `launch.json` or `package.json` script |

Capabilities are reported honestly. A Vite session does not claim Flutter's stateful hot reload, so the control panel greys the button out and agents get a clear refusal instead of a silent no-op.

---

## Use it

Baton reads what you already have. No new config file is required.

- `.vscode/launch.json` — your existing configs, read but never modified, so your IDE keeps working
- `.claude/launch.json` — same format
- `package.json` — `dev`, `start`, `serve`, `storybook` scripts, with the right package manager picked from your lockfile
- `pubspec.yaml` — Flutter projects with no launch.json still get a sensible default

```bash
baton list        # every target, and where it came from
baton run dev     # names match on any unambiguous substring
baton ps          # what's running
baton logs dev -f # follow output
baton reload --all
baton stop --all
baton devices --all   # connected devices, plus every one you could boot
```

### Multi-project agent workflows

Launch an API and a console in dependency order with one call:

```bash
baton workflow examples/workflow-lab/workflow.json
```

The result contains session IDs, readiness, URLs and focused failures. MCP agents use `run_workflow` for the same operation, then their browser/device tools to exercise the actual app. Try the dependency-free [two-project delivery lab](examples/workflow-lab/README.md): complete a delivery, inspect its receipt, stop the API to reproduce an outage, then recover it through Baton.

### Guided discovery and validation

The control panel re-reads launch sources while visible, on focus, and through **Refresh**. Its guidance card shows the selected environment, source file, entrypoint, build mode and setup issues. Device and branch menus follow the selected target's project, including in **All**.

```bash
baton doctor                 # fresh sources, blockers, nested projects, guidance
baton doctor --json          # structured inspection without environment values
baton proof "Local lab" --branch main --devices "iPhone 17 Pro" --appearance light,dark
```

Agents get the same report through MCP `inspect_project`. Proof runs respect the requested project, branch or existing worktree. Screenshots are evidence for a person or agent to review; capture success alone is not visual correctness.

Start with the credential-free [Flutter lab](examples/flutter-lab) and follow the [launch and validation guide](docs/launch-guide.md), with instructions for both people and agents.

### Devices you haven't started yet

`baton devices --all` lists what is connected *and* what could be:

```
connected
  ● iPhone 17 Pro                48F0A0D1-…  ios (emulator)
  ● sdk gphone16k arm64          emulator-5556  android (emulator)

bootable
  ○ iPhone 17 Pro Max            3237F94B-…  ios  iOS 26.5
  ○ iPad mini (A17 Pro)          51470177-…  ios  iOS 26.5
  ○ Pixel 10 Pro                 Pixel_10_Pro  android
```

Individual iOS models, not a generic "start a simulator" — Flutter's own emulator list collapses every iPhone and iPad into one entry, so `simctl` is asked directly. `baton boot "iPad mini"` starts one and waits until Flutter can actually see it, then tells you the device id to run on. In the control panel, picking a device under **Start new** boots it and launches on exactly that device in one press.

### Several projects at once

The daemon is not tied to one directory. Track as many projects as you work in:

```bash
baton add ~/code/storefront
baton add ~/code/api
baton projects
```

The control panel then shows a tab per project with a live count, plus **All** — every session from every project in one list, grouped and labelled. Reload-all while looking at one project reloads only that project. Session ids are project-scoped (`storefront/npm-dev`, `api/npm-dev`), so two projects can both have an `npm dev` without colliding.

### A branch without switching git

The launcher's **Checkout** menu is This checkout (your current folder, dirty files included) by default. Pick a local or remote branch and Baton makes a git worktree under `~/.baton/worktrees`, copies secrets/config from your folder (not `build/` or `node_modules`), and runs from that copy. Your branch, stash, and VS Code folder do not move.

Existing worktrees of the repo (the folders agents already edit) show up in the same menu — attach one to a sim and hot reload follows **that** folder. Stop keeps the copy so the next Run is warm. Dismissing the session deletes only copies Baton created; agent worktrees stay.

```bash
baton run "iOS Simulator (DEV)" --branch origin/main
baton run "iOS Simulator (DEV)" --checkout ~/wt/agent-a
baton checkouts
```

Sessions live in a background daemon, so **closing the terminal doesn't kill your app**. Open a new terminal and `baton ps` still shows everything.

### Pre-flight checks

Configs often reference gitignored files — per-developer secrets, local overrides. Flutter fails deep inside the build when one is missing, far from the cause. Baton checks first and refuses to spawn:

```
✗ "iOS Simulator (DEV / dev flavor)" cannot run yet:
  missing config/secrets.local.json — copy config/secrets.local.template.json to config/secrets.local.json
```

`baton list` flags blocked targets the same way. Use `--force` to run anyway.

### The control panel

```bash
baton app
```

One compact row per session: status, ⟳ ⟲ ■, logs, and links to the app URL and DevTools. `r` hot-reloads everything in view, `R` hot-restarts.

On **macOS** this opens a native floating launcher and a menu-bar item:

**Linux/Windows:** Same page as a chromeless browser window. Single self-contained file, served on loopback.

The small AppKit host serves the same page and is compiled from source on first use — no opaque binary to trust, and it rebuilds only when that source changes. It needs Xcode or the Command Line Tools; without them Baton opens in the browser instead.

On **Linux and Windows** (or with `baton app --browser`) the same page opens as an app-style browser window. It is self-contained, makes no external requests, and is served on loopback by the daemon.

Settings cover system/light/dark appearance, reduced motion, startup view, last-project restoration, Stop-all confirmation, always-on-top, and launch-at-login. See the [Baton app settings](docs/app-settings.md). The older `hud` name described the first tiny floating display; it is retained only as a command and implementation compatibility alias.

### Branch without switching git

Pick a branch from the **Checkout** menu and Baton makes a git worktree — your branch, stash, and VS Code folder don't move. Stop keeps the copy warm; dismissing deletes only Baton-created copies.

```bash
baton run "iOS Simulator (DEV)" --branch origin/main
```

### Multi-project workflows

Launch an API and console in dependency order:

```bash
baton workflow examples/workflow-lab/workflow.json
```

### Pre-flight checks

Configs often reference gitignored files. Baton checks first:

```
✗ "iOS Simulator (DEV)" cannot run yet:
  missing config/secrets.local.json — copy config/secrets.local.template.json
```

### Boot devices by name

```bash
baton devices --all    # what's connected and what could be
baton boot "iPad mini" # start it and wait until Flutter can see it
```

---

## Performance

Tested against a 3,692-library production Flutter app:

| Metric | Result |
|---|---|
| Hot reload | 87ms |
| Hot restart | 359ms |
| Simultaneous simulators | 3 |

See [ROI Scenarios](https://kanumuri9593.github.io/Baton/roi.html) for modeled time/cost savings with transparent assumptions.

---

## How It Works

```
.vscode/launch.json ─┐
package.json  ───────┼─► detect ─► daemon ─► one session per target
pubspec.yaml  ───────┘                │
                                      │
                     WebSocket + POST /rpc on 127.0.0.1
                          ├── Baton app      (native panel on macOS, browser elsewhere)
                          ├── baton      (any terminal)
                          └── baton-mcp  (any MCP client)
```

One daemon owns every session, so a session you start in a terminal is instantly visible in the control panel and to your agent. The daemon writes `~/.baton/daemon.json` (mode 0600) with its port and a token; clients read it and authenticate. Nothing listens off-loopback.

For Flutter, sessions are `flutter run --machine` children and every control is one request:

| Button | Request |
|---|---|
| ⟳ hot reload | `app.restart` with `fullRestart: false` |
| ⟲ hot restart | `app.restart` with `fullRestart: true` |
| ■ stop | `app.stop` |
| debug flags | `app.callServiceExtension` |

FVM is respected: a project pinning a Flutter version through `.fvm/flutter_sdk` uses that SDK, never a different one from `PATH`.

## Focused diagnostics across projects

Node launch targets can opt into `"batonTrace": true` for local OpenTelemetry HTTP/HTTPS and `fetch` metadata. The existing Network panel shows requests; **Diagnose → Follow trace** connects the console to its backend. Flutter keeps its VM-service HTTP capture.

```bash
baton diagnose                    # errors across sessions, bounded output
baton diagnose <trace-id> --all    # related requests across Node projects
```

See the [coverage and setup guide](docs/launch-guide.md#local-backend-tracing-using-opentelemetry). Baton captures evidence; browser/device interaction and visual interpretation remain explicit steps in the agent workflow.

---

**0.2.1** is working and tested against a large production Flutter app (3,692 libraries): hot reload in 87ms, hot restart in 359ms, with three simulators running at once — and against three projects (Flutter, Vite, a plain worker) running side by side in one control panel, one of them launched onto a simulator booted from Baton itself.

The Flutter adapter is the most complete. Web and React Native adapters cover run/restart/logs/URL detection; contributions extending them are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Feedback from other agent setups is the point of this release: [open an issue](https://github.com/kanumuri9593/Baton/issues) or a discussion. Please include OS, Node version, the MCP client, and whether you used the CLI or Baton app.

## The icon

`assets/baton.svg` is the only source of truth: a conductor's baton sweeping
across three running lanes. Everything else is derived from it —

```bash
npm run icons     # PNGs at every common size, plus a macOS .icns
```

- `assets/baton.svg` — the app tile (gradient squircle with white baton + arcs)
- `assets/baton-mark.svg` — the mark with `currentColor` baton for theme adaptation
- `assets/baton-glyph.svg` — monochrome baton for 16px / menu-bar / favicon
- `assets/baton-wordmark.svg` — tile plus wordmark

Generated PNGs and the `.icns` are gitignored, so the icon can never end up edited in two places.

---

## Development

```bash
npm install
npm run build     # compile TypeScript to dist/
npm test          # portable tests, no simulator required
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

---

## Status

**v0.2.1** is working and tested against a large production Flutter app (3,692 libraries): hot reload in 87ms, hot restart in 359ms, with three simulators running at once.

The Flutter adapter is the most complete. Web and React Native adapters cover run/restart/logs/URL detection — contributions extending them are welcome.

[Open an issue](https://github.com/kanumuri9593/Baton/issues) with OS, Node version, MCP client, and whether you used CLI or HUD.

---

## License

MIT
