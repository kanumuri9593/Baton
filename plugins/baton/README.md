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
| Baton band | Sits above the prompt while anything runs: each app, its simulator or URL, its status, plus Reload all, Pause all / Resume all, Bring to front and Stop all (asks to confirm) |
| `/baton` panel | New run (pick a project, target and device, or boot a simulator), then every run with CPU and memory and Reload, Restart, Pause/Resume, Bring to front, Screenshot, live Logs and Stop or Dismiss. The desktop app also shows the last screenshot |

The band and panel read the same Baton daemon as the tools, so a run started by Claude, the
`baton` CLI or the Baton app shows up in every Claude Code session on the machine. Hide the
band with its Hide button; `/baton` brings it back.

Try it: open a Flutter or web project and ask "run the app and show me a screenshot".

## Links

- Baton: https://kanumuri9593.github.io/Baton/
- Source and issues: https://github.com/kanumuri9593/Baton
- Built by Yeswanth Varma Kanumuri. MIT license.
