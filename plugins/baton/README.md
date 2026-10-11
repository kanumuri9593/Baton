# Baton for Claude Code

Lets Claude run, hot-reload, screenshot and debug your apps: Flutter, Next.js, Vite,
React Native / Expo, and native iOS and Android. Claude presses the same Run, Reload and
Stop buttons you do, and sees the same sessions as your terminal and the Baton app.

## Install

Inside Claude Code:

```
/plugin marketplace add kanumuri9593/Baton
/plugin install baton@baton
```

Or in one step on Claude Code 2.1.275 or later:

```
/plugin install baton --marketplace kanumuri9593/Baton
```

Requires **Node.js 24+**. The first tool call downloads `baton-run` from npm with `npx`.

## What you get

| Part | What it does |
|---|---|
| `baton` MCP server | 29 tools: inspect, boot a simulator, run, wait, `check_change` after every edit, hot reload/restart, logs, screenshots (devices and web), network, diagnose, proofs |
| Baton card | Ask "show Baton" in the Claude app: a live control panel in the chat. Start a run on any simulator or boot one, then Reload, Restart, Pause/Resume, Bring to front, Logs, Screenshot and Stop per app, or all at once |
| `using-baton` skill | Teaches Claude the run → wait → edit → `check_change` loop, used automatically |
| `/baton:run [target]` | Run a target, wait until it is ready, report URL/device/errors |
| `/baton:doctor` | Check Node, the MCP server and the project setup, with fixes |
| Baton band | Sits above the prompt while anything runs, in the terminal and the desktop app: one row per app with a status dot, device icon, short name, simulator or URL, CPU and memory, and icon buttons: ☰ logs, 🐞 debug (asks Claude to find and fix the run's errors), ▶ play (hot reload, resume, or run again once it ends), ⏸ pause, ⏹ stop (✕ dismiss once it ends) and ⧉ bring that run's simulator to the front. The header has ＋ new run and the same ▶ ⏸ ⏹ ⧉ for every run at once, plus ✕ to hide the band. Pause and bring to front are macOS only |
| `/baton` | The same workspace in a side pane, with longer logs. Also brings a hidden band back |

The band and panel read the same Baton daemon as the tools, so a run started by Claude, the
`baton` CLI or the Baton app shows up in every Claude Code session on the machine. Hide the
band with its ✕ button; `/baton` brings it back.

Try it: open a Flutter or web project and ask "run the app and show me a screenshot".

## What the plugin does on your machine

Everything stays on your computer. The plugin talks only to the local Baton daemon and starts
only the programs listed here.

- **MCP server.** `.mcp.json` runs `npx -y --package=baton-run@<version> baton-mcp`, the
  published [`baton-run`](https://www.npmjs.com/package/baton-run) package pinned to this
  plugin's version (npm provenance, built from this repository by GitHub Actions).
- **Network.** The band and `/baton` pane call one address: `http://127.0.0.1:<port>/rpc`, the
  Baton daemon on loopback. The port and a bearer token come from `~/.baton/daemon.json`, which
  the daemon writes (mode 0600) and which Baton itself created. The token is sent only to that
  loopback address. Nothing is sent to any other host. The `http://www.w3.org/2000/svg` text in
  `hooks/register.tsx` is the standard SVG namespace for the band's icons, not a request.
- **Programs it starts**, always with fixed arguments:
  - `uname -s`, once, to tell whether this is macOS.
  - `ps -axo pid=,ppid=,stat=,command=`, to find the app processes of runs Baton started.
  - `kill -STOP` and `kill -CONT` on those process ids, for the ⏸ and ▶ buttons (macOS).
  - `open -a Simulator` and `osascript -l JavaScript`, which posts the
    `com.apple.iphonesimulator.startSession` notification for one simulator id, for ⧉ bring to
    front (macOS). For a web run, ⧉ runs `open <run URL>` to show the page.
- **Prompts it submits.** The 🐞 debug button submits one prompt: "Debug *run name* on *device*
  (Baton session *id*): read its recent errors and logs with Baton, find the cause, fix it, then
  check_change to confirm." The ＋ button only fills the prompt with `/baton:run ` and does not
  send it.
- **Hooks.** `session.start` registers `/baton` and starts polling the daemon every 2 seconds.
  `command.run` for `baton` opens the pane. `ui.render` draws the band above the prompt and the
  pane. No hook reads, changes or blocks tool calls or your prompts.

## Links

- Baton: https://kanumuri9593.github.io/Baton/
- Source and issues: https://github.com/kanumuri9593/Baton
- Built by Yeswanth Varma Kanumuri. MIT license.
