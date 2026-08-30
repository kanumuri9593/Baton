# CLI-Launch

**Run, hot-reload and stop your dev sessions from any terminal — and let your coding agent do the same.**

If the only reason you keep an IDE open is its Run & Debug toolbar — the config picker, the ⟳ ⟲ ■ buttons, three simulators at once — this replaces that, and adds the half an IDE can't give you: your agent can press the same buttons.

```bash
clilaunch list                                  # what can I run here?
clilaunch run "iOS Simulator (DEV / dev flavor)"
clilaunch reload --all                          # hot reload every session
clilaunch hud                                   # floating control panel
```

---

## Why

Modern development looks like this: several terminals running coding agents, plus one IDE kept alive purely for its run button. The IDE isn't being used to write code any more. It's a launcher.

That toolbar isn't privileged IDE plumbing. `flutter run --machine` speaks a documented JSON protocol on stdio — hot reload is one request on it. CLI-Launch drives that protocol directly, so the toolbar becomes a daemon that any terminal, any window, and any agent can talk to.

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
npm install -g clilaunch
```

Requires Node 24 or newer (it runs TypeScript natively — there is no build step).

## Use it

CLI-Launch reads what you already have. No new config file is required.

- `.vscode/launch.json` — your existing configs, read but never modified, so your IDE keeps working
- `.claude/launch.json` — same format
- `package.json` — `dev`, `start`, `serve`, `storybook` scripts, with the right package manager picked from your lockfile
- `pubspec.yaml` — Flutter projects with no launch.json still get a sensible default

```bash
clilaunch list        # every target, and where it came from
clilaunch run dev     # names match on any unambiguous substring
clilaunch ps          # what's running
clilaunch logs dev -f # follow output
clilaunch reload --all
clilaunch stop --all
clilaunch devices     # simulators, emulators, physical devices
```

Sessions live in a background daemon, so **closing the terminal doesn't kill your app**. Open a new terminal and `clilaunch ps` still shows everything.

### The floating HUD

```bash
clilaunch hud
```

Opens a compact panel: one row per session with status, ⟳ ⟲ ■, logs, and links to the app URL and DevTools. Keep it in a small always-on-top window beside your terminals. `r` hot-reloads everything, `R` hot-restarts.

It's a single self-contained page with no external requests, served on loopback by the daemon — so it looks and behaves the same on every OS.

## Give it to your agent

CLI-Launch ships an MCP server, so any MCP-capable agent gets real tools instead of shelling out and scraping text.

**Claude Code**

```bash
claude mcp add clilaunch -- clilaunch-mcp
```

**Cursor, Windsurf, Zed, Codex, Gemini CLI** — anything that reads an MCP config:

```json
{
  "mcpServers": {
    "clilaunch": { "command": "clilaunch-mcp" }
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
                          WebSocket on 127.0.0.1
                          ├── HUD            (any browser, any OS)
                          ├── clilaunch      (any terminal)
                          └── clilaunch-mcp  (any agent)
```

One daemon owns every session, so a session you start in a terminal is instantly visible in the HUD and to your agent. The daemon writes `~/.clilaunch/daemon.json` (mode 0600) with its port and a token; clients read it and authenticate. Nothing listens off-loopback.

For Flutter, sessions are `flutter run --machine` children and every control is one request:

| Button | Request |
|---|---|
| ⟳ hot reload | `app.restart` with `fullRestart: false` |
| ⟲ hot restart | `app.restart` with `fullRestart: true` |
| ■ stop | `app.stop` |
| debug flags | `app.callServiceExtension` |

FVM is respected: a project pinning a Flutter version through `.fvm/flutter_sdk` uses that SDK, never a different one from `PATH`.

## Status

Working and tested against a large production Flutter app (3,692 libraries): hot reload in 87ms, hot restart in 359ms, with three simulators running at once.

The Flutter adapter is the most complete. Web and React Native adapters cover run/restart/logs/URL detection; contributions extending them are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm install
npm test          # 63 tests, no simulator required
npm run typecheck
```

Tests replay transcripts captured from a real `flutter run --machine` session, so the wire format is a regression test rather than an assumption.

## License

MIT
