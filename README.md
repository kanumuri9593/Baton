<p align="center">
  <img src="assets/baton.svg" width="88" alt="Baton" style="border-radius: 20px">
</p>

<h1 align="center">Baton</h1>

<p align="center">
  <strong>The local run control plane for people and coding agents.</strong><br>
  Run, hot-reload, boot simulators, and capture evidence for Flutter, Next.js, Vite, and React Native from a terminal, the Baton app, or any MCP-compatible agent.
</p>

<p align="center">
  <a href="https://kanumuri9593.github.io/Baton/">kanumuri9593.github.io/Baton</a>
</p>

<p align="center">
  <a href="https://github.com/kanumuri9593/Baton/blob/master/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0ea5e9"></a>
  <a href="https://github.com/kanumuri9593/Baton/releases/tag/v0.2.3"><img alt="Version 0.2.3" src="https://img.shields.io/badge/version-0.2.3-111827"></a>
  <a href="https://nodejs.org/"><img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-339933"></a>
  <a href="https://modelcontextprotocol.io/"><img alt="MCP server" src="https://img.shields.io/badge/MCP-baton--mcp-7c3aed"></a>
  <a href="https://github.com/kanumuri9593/Baton/issues/new?labels=feedback&title=Feedback"><img alt="Ask for feedback" src="https://img.shields.io/badge/feedback-welcome-f59e0b"></a>
</p>

```bash
npm install -g github:kanumuri9593/Baton
baton app
```

**Baton 0.2.3** is a public developer preview. Clone it, wire `baton-mcp` into your agent, try the labs, and [open an issue](https://github.com/kanumuri9593/Baton/issues) with what broke or what you wanted.

If the only reason you keep an IDE open is its Run & Debug toolbar — the config picker, the ⟳ ⟲ ■ buttons, three simulators at once — this replaces that, and adds the half an IDE can't give you: your agent can press the same buttons. Pick a **branch** (or an agent's worktree) and Baton runs it from a copy, so VS Code never has to stash or switch.

```bash
baton list                                  # what can I run here?
baton run "iOS Simulator (DEV / dev flavor)"
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
| **npm** | `npm install -g baton-run` |
| **Clone** | `git clone https://github.com/kanumuri9593/Baton.git && cd Baton && npm install && npm run build` |
| **Baton app** | After install: `baton app` — native floating launcher + control panel on macOS; app-style browser window on Linux/Windows. `baton hud` remains an alias. |
| **Source tarball** | [Releases](https://github.com/kanumuri9593/Baton/releases) |

Requires **Node.js 24+**. macOS, Linux, and Windows.

Pin a release:

```bash
npm install -g github:kanumuri9593/Baton#v0.2.3
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
npm install -g baton-run
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

**Tools:** `inspect_project`, `list_targets`, `list_sessions`, `list_checkouts`, `list_devices`, `run_target`, `run_workflow`, `hot_reload`, `hot_restart`, `stop_session`, `forget_session`, `wait_for`, `read_logs`, `session_summary`, `screenshot`, `set_debug_flag`, `diagnose`, `list_network_requests`, `get_network_request`, `clear_network_requests`, `read_launch_config`, `write_launch_config`, `run_proof`, `list_proofs`, `list_run_history`.

Typical loop: inspect → run (or `run_workflow`) → wait → use your browser/device tools on the live app → screenshot / logs / diagnose → edit → hot reload.

Failed reloads return the compiler errors, not just `DevFS synchronization failed`:

```
lib/main.dart:419:19: Error: Expected ';' after this.
```

That's the difference between an agent that can fix its own mistake and one that's stuck.

---

## Why

Modern development looks like this: several terminals running coding agents, plus one IDE kept alive purely for its run button. The IDE isn't being used to write code any more. It's a launcher.

That toolbar isn't privileged IDE plumbing. `flutter run --machine` speaks a documented JSON protocol on stdio — hot reload is one request on it. Baton drives that protocol directly, so the toolbar becomes a daemon that any terminal, any window, and any agent can talk to.

The result is a control surface your agent shares with you:

> edit a widget → `hot_reload` → `screenshot` → see whether it actually worked

No IDE can offer that, because the agent isn't holding the mouse.

## What it supports

| Framework | Hot reload (keeps state) | Restart | Notes |
|---|---|---|---|
| **Flutter / Dart** | ✅ real, via the daemon protocol | ✅ hot restart | Devices, DevTools, debug flags, screenshots |
| **Next.js, Vite, Nuxt, Astro, Remix, Angular, CRA** | HMR is automatic on save | ✅ reboots the dev server | Detects the real URL and readiness |
| **React Native / Expo** | Fast Refresh is automatic | ✅ reload broadcast to dev clients | Talks to Metro's message socket |
| **Native iOS (Xcode)** | — | ✅ rebuild, reinstall, relaunch | Builds for the selected simulator, installs, launches, follows logs, screenshots |
| **Native Android (Gradle)** | — | ✅ rebuild, reinstall, relaunch | `installDebug`, starts the launcher activity, follows logcat, screenshots |
| **Anything else** | — | ✅ kill and respawn | Any `launch.json` or `package.json` script |

Capabilities are reported honestly. A Vite session does not claim Flutter's stateful hot reload, so the control panel greys the button out and agents get a clear refusal instead of a silent no-op.

**Runs on macOS, Linux and Windows.** Node 24+, zero build step.

## Use it

Baton reads what you already have. No new config file is required.

- `.vscode/launch.json` — your existing configs, read but never modified, so your IDE keeps working
- `.claude/launch.json` — same format
- `package.json` — `dev`, `start`, `serve`, `storybook` scripts, with the right package manager picked from your lockfile
- `pubspec.yaml` — Flutter projects with no launch.json still get a sensible default
- Xcode — `.xcodeproj` / `.xcworkspace`, shared schemes, `Podfile`, or `Package.swift`
- Gradle — `settings.gradle(.kts)`, the wrapper, application modules, or a lone `AndroidManifest.xml` as a project marker

Picking a nested `ios/` or `android/` folder (or a file inside one) tracks that native project. Picking the Flutter or React Native root still prefers the framework runner, which is what actually hot-reloads. Native sessions build, install and **launch** on the device you pick, then stay running on the app log stream. Restart rebuilds and relaunches. They do not claim Flutter-style hot reload.

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

The control panel then shows a side rail per project with a live count, plus **All** — every session from every project in one list, grouped by workspace when several were launched together. Each project and each session has its own stop and remove controls. Reload-all while looking at one project reloads only that project. Session ids are project-scoped (`storefront/npm-dev`, `api/npm-dev`), so two projects can both have an `npm dev` without colliding.

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

One compact row per session: status, reload / restart / stop, logs, and links to the app URL and DevTools. Projects sit in a collapsible side rail instead of a top tab strip. `r` hot-reloads everything in view, `R` hot-restarts.

On **macOS** this opens a native floating launcher and a menu-bar item:

- stays above a full-screen terminal, and follows you between desktops
- never steals focus — clicking Run leaves your cursor where it was
- drag it anywhere by its title strip; it remembers where you put it
- the menu-bar item shows how many sessions are live (`●3`, orange while starting, red on failure); click it to show or hide the panel, right-click for reload/restart/stop all

The small AppKit host serves the same page and is compiled from source on first use — no opaque binary to trust, and it rebuilds only when that source changes. It needs Xcode or the Command Line Tools; without them Baton opens in the browser instead.

On **Linux and Windows** (or with `baton app --browser`) the same page opens as an app-style browser window. It is self-contained, makes no external requests, and is served on loopback by the daemon.

Settings cover system/light/dark appearance, reduced motion, startup view, last-project restoration, Stop-all confirmation, always-on-top, and launch-at-login. See the [Baton app settings](docs/app-settings.md). The older `hud` name described the first tiny floating display; it is retained only as a command and implementation compatibility alias.

## How it works

```
.vscode/launch.json ─┐
package.json  ───────┤
pubspec.yaml  ───────┼─► detect ─► daemon ─► one session per target
Xcode / Gradle  ─────┘                │       (flutter | web-dev | react-native | ios | android | process)
                                      │
                     WebSocket + POST /rpc on 127.0.0.1
                          ├── Baton app      (native panel on macOS, browser elsewhere)
                          ├── baton      (any terminal)
                          └── baton-mcp  (any agent)
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

## Status

**0.2.3** is working and tested against a large production Flutter app (3,692 libraries): hot reload in 87ms, hot restart in 359ms, with three simulators running at once — and against three projects (Flutter, Vite, a plain worker) running side by side in one control panel, one of them launched onto a simulator booted from Baton itself.

The Flutter adapter is the most complete. Web and React Native adapters cover run/restart/logs/URL detection; contributions extending them are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Feedback from other agent setups is the point of this release: [open an issue](https://github.com/kanumuri9593/Baton/issues) or a discussion. Please include OS, Node version, the MCP client, and whether you used the CLI or Baton app.

## The icon

The app icon is a full production asset, with a matching vector system for the
places where a detailed bitmap would lose clarity:

```bash
npm run icons     # PNGs at every common size, plus a macOS .icns
```

- `assets/baton-app-icon.png` — 1024px full-bleed Dock/App Store master; macOS
  applies the squircle, so this source deliberately has no baked-in outer mask
- `assets/baton.svg` — vector companion used by the compact launcher and README
- `assets/baton-favicon.svg` — simplified 16px browser-tab treatment
- `assets/baton-mark.svg` — fieldless UI mark in `currentColor`
- `assets/baton-glyph.svg` — baton-only menu-bar treatment
- `assets/baton-wordmark.svg` — presentation lockup

Generated size variants and the `.icns` are gitignored. Opening the macOS app
regenerates the `.icns` whenever the production master changes.

## Development

```bash
npm install
npm test          # portable tests, no simulator required
npm run typecheck
```

Tests replay transcripts captured from a real `flutter run --machine` session, so the wire format is a regression test rather than an assumption.

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

MIT
