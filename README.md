<p align="center">
  <img src="assets/baton.svg" width="88" alt="Baton">
</p>

<h1 align="center">Baton</h1>

<p align="center">
  <strong>Runtime control for coding agents.</strong><br>
  MCP server, CLI, and floating HUD. Run, hot-reload, boot simulators, and screenshot<br>
  Flutter, Next.js, Vite, and React Native apps from any terminal — or hand the same<br>
  buttons to any MCP-compatible coding agent.
</p>

<p align="center">
  <a href="https://kanumuri9593.github.io/Baton/">Website</a> ·
  <a href="https://github.com/kanumuri9593/Baton/blob/master/docs/launch-guide.md">Docs</a> ·
  <a href="https://kanumuri9593.github.io/Baton/roi.html">ROI</a> ·
  <a href="https://github.com/kanumuri9593/Baton/issues/new?labels=feedback&title=Feedback">Feedback</a>
</p>

<p align="center">
  <a href="https://github.com/kanumuri9593/Baton/blob/master/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0ea5e9"></a>
  <a href="https://github.com/kanumuri9593/Baton/releases/tag/v0.2.1"><img alt="Version 0.2.1" src="https://img.shields.io/badge/version-0.2.1-111827"></a>
  <a href="https://nodejs.org/"><img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-339933"></a>
  <a href="https://modelcontextprotocol.io/"><img alt="MCP server" src="https://img.shields.io/badge/MCP-baton--mcp-7c3aed"></a>
</p>

---

## The Problem

Developers increasingly ask coding agents to run `npm start`, watch a terminal, wait for a port, read logs, restart a process, or take a screenshot. Those are deterministic computer tasks, yet every terminal command, poll, and pasted log consumes model tokens, time, and money. The agent becomes an expensive shell wrapper.

Meanwhile, if the only reason you keep an IDE open is its Run & Debug toolbar — the config picker, the ⟳ ⟲ ■ buttons, three simulators at once — that's what Baton replaces. And it adds what an IDE can't give you: **your agent can press the same buttons.**

```bash
baton list                                  # what can I run here?
baton run "iOS Simulator (DEV)"
baton run "iOS Simulator (DEV)" --branch origin/main
baton reload --all                          # hot reload every session
baton boot "iPhone 17 Pro Max"              # start a simulator that isn't running
baton hud                                   # floating panel + menu-bar item
```

---

## Install

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

### The HUD

There is **no App Store download** — the HUD is `baton hud`:

- **macOS**: native floating panel + menu-bar item. First run compiles ~250 lines of AppKit from `hud/` (needs Xcode or Command Line Tools).
- **Linux / Windows**: chromeless browser window.

First launch may take a few seconds while the panel compiles.

### Troubleshooting

**ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING** — If you installed an old `baton-run@0.2.0` that tried to import `.ts` files directly:

```bash
npm uninstall -g baton-run
npm install -g github:kanumuri9593/Baton   # or wait for baton-run@0.2.1+ on npm
```

---

## Connect to Your Agent

Baton is an MCP server. Agents get structured tools instead of scraping terminal output. Add it to any MCP-compatible client:

**Claude Code**

```bash
claude mcp add baton -- baton-mcp
```

**Cursor, Windsurf, Codex, Gemini CLI, Zed, Claude Desktop** — add to your MCP config:

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

Capabilities are reported honestly. A Vite session does not claim Flutter's stateful hot reload — agents get a clear refusal instead of a silent no-op.

---

## The Floating HUD

```bash
baton hud
```

One compact row per session: status, ⟳ ⟲ ■, logs, and links to the app URL and DevTools. `r` hot-reloads everything in view, `R` hot-restarts.

**macOS:** Native floating panel + menu-bar item. Stays above full-screen terminals, follows between desktops, never steals focus. The menu-bar item shows live session counts (●3, orange while starting, red on failure).

**Linux/Windows:** Same page as a chromeless browser window. Single self-contained file, served on loopback.

---

## Use Cases

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
                          ├── HUD        (native panel on macOS, browser elsewhere)
                          ├── baton      (any terminal)
                          └── baton-mcp  (any MCP client)
```

One daemon owns every session. The daemon writes `~/.baton/daemon.json` (mode 0600) with its port and token — nothing listens off-loopback.

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

## The Icon

`assets/baton.svg` is the source of truth: a conductor's baton with signal arcs on an indigo→cyan gradient squircle.

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
