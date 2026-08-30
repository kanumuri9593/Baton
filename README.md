<p align="center">
  <img src="assets/baton.svg" width="88" alt="Baton">
</p>

<h1 align="center">Baton</h1>

<p align="center">
  <strong>Conduct your dev sessions from any terminal — and hand the baton to your coding agent.</strong>
</p>

---

Run, hot-reload, restart and stop everything you are building, from the terminal you already have open. Several projects at once, on devices you can boot from the same place, with a floating panel that never steals your focus — and the same controls exposed to any MCP-capable agent.

If the only reason you keep an IDE open is its Run & Debug toolbar — the config picker, the ⟳ ⟲ ■ buttons, three simulators at once — this replaces that, and adds the half an IDE can't give you: your agent can press the same buttons.

```bash
baton list                                  # what can I run here?
baton run "iOS Simulator (DEV / dev flavor)"
baton reload --all                          # hot reload every session
baton boot "iPhone 17 Pro Max"              # start a simulator that isn't running
baton add ~/code/storefront                 # watch another project too
baton hud                                   # floating panel + menu-bar item
```

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
| **Anything else** | — | ✅ kill and respawn | Any `launch.json` or `package.json` script |

Capabilities are reported honestly. A Vite session does not claim Flutter's stateful hot reload, so the HUD greys the button out and agents get a clear refusal instead of a silent no-op.

**Runs on macOS, Linux and Windows.** Node 24+, zero build step.

## Install

```bash
npm install -g baton-run
```

The command is `baton`; the package is `baton-run` because the bare `baton` name
on npm is held by an empty 0.0.0 placeholder. Requires Node 24 or newer (it runs
TypeScript natively — there is no build step).

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

Individual iOS models, not a generic "start a simulator" — Flutter's own emulator list collapses every iPhone and iPad into one entry, so `simctl` is asked directly. `baton boot "iPad mini"` starts one and waits until Flutter can actually see it, then tells you the device id to run on. In the HUD, picking a device under **Start new** boots it and launches on exactly that device in one press.

### Several projects at once

The daemon is not tied to one directory. Track as many projects as you work in:

```bash
baton add ~/code/storefront
baton add ~/code/api
baton projects
```

The HUD then shows a tab per project with a live count, plus **All** — every session from every project in one list, grouped and labelled. Reload-all while looking at one project reloads only that project. Session ids are project-scoped (`storefront/npm-dev`, `api/npm-dev`), so two projects can both have an `npm dev` without colliding.

Sessions live in a background daemon, so **closing the terminal doesn't kill your app**. Open a new terminal and `baton ps` still shows everything.

### Pre-flight checks

Configs often reference gitignored files — per-developer secrets, local overrides. Flutter fails deep inside the build when one is missing, far from the cause. Baton checks first and refuses to spawn:

```
✗ "iOS Simulator (DEV / dev flavor)" cannot run yet:
  missing config/secrets.local.json — copy config/secrets.local.template.json to config/secrets.local.json
```

`baton list` flags blocked targets the same way. Use `--force` to run anyway.

### The floating HUD

```bash
baton hud
```

One compact row per session: status, ⟳ ⟲ ■, logs, and links to the app URL and DevTools. Above it, a tab per project and a picker for target and device. `r` hot-reloads everything in view, `R` hot-restarts.

On **macOS** this opens a native floating panel and a menu-bar item:

- stays above a full-screen terminal, and follows you between desktops
- never steals focus — clicking Run leaves your cursor where it was
- drag it anywhere by its title strip; it remembers where you put it
- the menu-bar item shows how many sessions are live (`●3`, orange while starting, red on failure); click it to show or hide the panel, right-click for reload/restart/stop all

The panel is ~250 lines of AppKit hosting the same page, compiled from source on first use — no signed binary to trust, and it rebuilds only when that source changes. It needs Xcode or the Command Line Tools; without them you get the browser HUD instead.

On **Linux and Windows** (or with `baton hud --browser`) the same page opens as a small chromeless window. It is a single self-contained file with no external requests, served on loopback by the daemon, so it looks and behaves the same everywhere.

## Give it to your agent

Baton ships an MCP server, so any MCP-capable agent gets real tools instead of shelling out and scraping text.

**Claude Code**

```bash
claude mcp add baton -- baton-mcp
```

**Cursor, Windsurf, Zed, Codex, Gemini CLI** — anything that reads an MCP config:

```json
{
  "mcpServers": {
    "baton": { "command": "baton-mcp" }
  }
}
```

Tools: `list_targets`, `list_sessions`, `run_target`, `hot_reload`, `hot_restart`, `stop_session`, `read_logs`, `list_devices`, `set_debug_flag`, `screenshot`.

Agents that don't speak MCP can just use the CLI — every command is scriptable and exits non-zero on failure.

**Failed reloads carry the actual compiler errors.** A broken edit returns not just `DevFS synchronization failed` but the diagnostics themselves:

```
lib/main.dart:419:19: Error: Expected ';' after this.
```

That's the difference between an agent that can fix its own mistake and one that's stuck.

## How it works

```
.vscode/launch.json ─┐
package.json  ───────┼─► detect ─► daemon ─► one session per target
pubspec.yaml  ───────┘                │       (flutter | web-dev | react-native | process)
                                      │
                     WebSocket + POST /rpc on 127.0.0.1
                          ├── HUD            (native panel on macOS, browser elsewhere)
                          ├── baton      (any terminal)
                          └── baton-mcp  (any agent)
```

One daemon owns every session, so a session you start in a terminal is instantly visible in the HUD and to your agent. The daemon writes `~/.baton/daemon.json` (mode 0600) with its port and a token; clients read it and authenticate. Nothing listens off-loopback.

For Flutter, sessions are `flutter run --machine` children and every control is one request:

| Button | Request |
|---|---|
| ⟳ hot reload | `app.restart` with `fullRestart: false` |
| ⟲ hot restart | `app.restart` with `fullRestart: true` |
| ■ stop | `app.stop` |
| debug flags | `app.callServiceExtension` |

FVM is respected: a project pinning a Flutter version through `.fvm/flutter_sdk` uses that SDK, never a different one from `PATH`.

## Status

Working and tested against a large production Flutter app (3,692 libraries): hot reload in 87ms, hot restart in 359ms, with three simulators running at once — and against three projects (Flutter, Vite, a plain worker) running side by side in one HUD, one of them launched onto a simulator booted from the HUD itself.

The Flutter adapter is the most complete. Web and React Native adapters cover run/restart/logs/URL detection; contributions extending them are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## The icon

`assets/baton.svg` is the only source of truth: a conductor's baton sweeping
across three running lanes. Everything else is derived from it —

```bash
npm run icons     # PNGs at every common size, plus a macOS .icns
```

- `assets/baton.svg` — the app tile, for anywhere with a background of its own
- `assets/baton-mark.svg` — the bare mark; the baton takes `currentColor`, so it
  inverts correctly on light and dark
- `assets/baton-glyph.svg` — the baton alone, for anything under ~20px. The
  menu-bar item draws this same geometry as an AppKit template image, which is
  why it stays crisp and tints itself to the menu bar it is sitting in
- `assets/baton-wordmark.svg` — mark plus wordmark

Generated PNGs and the `.icns` are gitignored, so the icon can never end up
edited in two places.

## Development

```bash
npm install
npm test          # 92 tests, no simulator required
npm run typecheck
```

Tests replay transcripts captured from a real `flutter run --machine` session, so the wire format is a regression test rather than an assumption.

## License

MIT
