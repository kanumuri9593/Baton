# Baton in Claude Code

Claude Code gets Baton as a plugin. It works in the terminal, the Claude desktop app and the
Claude Code extension for VS Code. The plugin adds:

| Part | What it does |
|---|---|
| `baton` MCP server | The 29 tools: inspect, boot a simulator, run, wait, `check_change`, hot reload and restart, logs, screenshots, network, diagnose, proofs |
| `using-baton` skill | Teaches Claude the run → wait → edit → `check_change` loop. Used automatically |
| `/baton:run [target]` | Run a target, wait until it is ready, report the URL or device and any errors |
| `/baton:doctor` | Check Node, the MCP server and the project setup, with fixes |
| The Baton band | One row per run above the prompt, with icon buttons |
| `/baton` | The same workspace in a side pane, with longer logs |

## One command

```bash
npm install -g baton-run
baton setup claude
```

This runs `claude plugin marketplace add kanumuri9593/Baton` and
`claude plugin install baton@baton` for you. If the plugin is already installed it says so and
changes nothing. `baton setup claude --remove` uninstalls it.

## Manual setup

Inside Claude Code:

```
/plugin marketplace add kanumuri9593/Baton
/plugin install baton@baton
```

On Claude Code 2.1.275 or later this also works in one step:

```
/plugin install baton --marketplace kanumuri9593/Baton
```

The plugin starts the server with `npx -y --package=baton-run@0.2.10 baton-mcp`, so it needs
Node.js 24+ but no global install. The first call downloads the package, which can take about
a minute.

Server only, without the skill, commands or band:

```bash
claude mcp add baton -- npx -y baton-run@0.2.10
```

## The band

While anything runs, Baton sits above the prompt. Each run gets one row: a status dot, a device
icon, a short name, the simulator or URL, CPU and memory, and these buttons:

| Button | What it does |
|---|---|
| ☰ | Show or hide the run's recent log lines under its row |
| 🐞 | Debug: submits a prompt asking Claude to read the run's errors and logs, fix the cause, and confirm with `check_change` |
| ▶ | Play: hot reload a running app (or restart it if it has no hot reload), resume a paused one, or run it again after it ended |
| ⏸ | Pause the app's processes (macOS) |
| ⏹ | Stop the run. After it ends this is ✕, which dismisses it from the list |
| ⧉ | Bring to front: raises that run's own simulator window, or opens its web URL (macOS) |

The header shows counts (running, paused, starting, failed) and has buttons for every run at
once: ＋ new run (puts `/baton:run ` in the prompt for you to finish), ▶ play all, ⏸ pause all,
⏹ stop all, ⧉ bring all to front (raises every device's window), and ✕ to hide the band. A
button that does not apply to a run is drawn dim.

`/baton` opens the same workspace in a pane and brings a hidden band back. Pause and bring to
front are macOS only; Android runs are left alone.

The band and pane read the same Baton daemon as the MCP tools, the `baton` CLI and the Baton
app, so a run started anywhere shows up in every Claude Code session on the machine.

## The Baton card

In the Claude desktop app and on claude.ai, ask "show Baton". Claude calls `show_dashboard`,
which draws a live card in the chat with every run, a New run button, and per-run controls.

## Verify

1. `/plugin` lists `baton@baton` as installed and enabled.
2. `/mcp` shows the `baton` server as connected.
3. Run `/baton:doctor`, or ask "list the Baton targets in this project".

## Troubleshooting

- **`baton` server failed in `/mcp`**: check `node --version` is 24 or newer. Then run
  `npx -y --package=baton-run@0.2.10 baton doctor` in a shell to see the error directly.
- **No band**: the band only appears while there is at least one run. Start one with
  `/baton:run`, or open `/baton`. If you hid it with ✕, `/baton` brings it back.
- **Buttons show words instead of icons in the desktop app**: update the `baton`
  marketplace and plugin from `/plugin`; 0.2.9 draws glyphs there.
- **⧉ raises the wrong simulator**: update to 0.2.9 or later. Earlier versions activated
  Simulator, which raised whichever of its windows was nearest.
- **Tools time out on a first iOS or Android build**: `wait_for` accepts up to 15 minutes.
  Ask Claude to wait on the session rather than re-running it.
