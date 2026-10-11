# Baton in Codex

The repository is a Codex plugin marketplace. The plugin adds Baton's MCP server and its skills
(`using-baton`, `run`, `doctor`), which describe how to run, reload and check an app.

## One command

```bash
npm install -g baton-run
baton setup codex
```

This adds a `[mcp_servers.baton]` table to `~/.codex/config.toml`, keeps every other line, and
saves the previous file as `config.toml.baton-backup`. It points at this install by absolute
path and copies your shell's `PATH` into the server's environment, so Flutter, Xcode and adb are
found. `baton setup codex --remove` takes the table out again.

`baton setup` configures the server only. For the skills, add the plugin as below.

## Manual setup

### Plugin (server and skills)

```bash
codex plugin marketplace add kanumuri9593/Baton
codex plugin add baton@baton
```

### Server only

`~/.codex/config.toml`:

```toml
[mcp_servers.baton]
command = "npx"
args = ["-y", "baton-run@0.2.9"]
tool_timeout_sec = 900
```

`tool_timeout_sec = 900` gives long steps, such as a first iOS build or `run_proof` across
devices, 15 minutes.

## Why the skills matter

Codex keeps MCP tools out of the prompt until it searches for them. Without a hint, "run my
app" may never reach Baton. The plugin's skills describe the job in words Codex matches, which
makes the Baton tools discoverable. With the server only, name Baton in your request ("use
Baton to run the app"), or add the loop from [docs/clients.md](../clients.md#the-loop-to-teach-your-agent)
to your `AGENTS.md`.

## Verify

1. Start a new Codex session and run `/mcp`. `baton` should be listed with its tools.
2. Ask: "Use Baton to inspect this project and list its targets."

## Troubleshooting

- **`baton` is missing from `/mcp`**: check the `[mcp_servers.baton]` table is in
  `~/.codex/config.toml` and that the file is valid TOML. Restart Codex after editing it.
- **The server fails to start**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.9 baton doctor` in a shell to see the error.
- **Tool calls time out during a native build**: make sure `tool_timeout_sec = 900` is set.
- **Codex runs `flutter run` in a shell instead**: install the plugin, or tell it to use Baton.
