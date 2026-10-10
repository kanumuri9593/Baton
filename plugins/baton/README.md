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
| `baton` MCP server | 25 tools: inspect, run, wait, hot reload/restart, logs, screenshots, network, diagnose, proofs |
| `using-baton` skill | Teaches Claude the run → wait → check → edit → reload loop, used automatically |
| `/baton:run [target]` | Run a target, wait until it is ready, report URL/device/errors |
| `/baton:doctor` | Check Node, the MCP server and the project setup, with fixes |
| Baton band | Sits above the prompt while anything runs: each app, its simulator or URL, its status, and Reload all |
| `/baton` panel | Every run with CPU and memory, plus Reload, Restart, Screenshot and Stop. The desktop app also shows the last screenshot |

The band and panel read the same Baton daemon as the tools, so a run started by Claude, the
`baton` CLI or the Baton app shows up in every Claude Code session on the machine. Hide the
band with its Hide button; `/baton` brings it back.

Try it: open a Flutter or web project and ask "run the app and show me a screenshot".

## Links

- Baton: https://kanumuri9593.github.io/Baton/
- Source and issues: https://github.com/kanumuri9593/Baton
- Built by Yeswanth Varma Kanumuri. MIT license.
