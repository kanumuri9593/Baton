# Baton in Antigravity

## One command

```bash
npm install -g baton-run
baton setup antigravity
```

This adds a `baton` entry under `mcpServers` in `~/.gemini/antigravity/mcp_config.json`,
leaves other servers alone, and saves the previous file as `mcp_config.json.baton-backup`. The
entry starts this install by absolute path and carries your shell's `PATH`, so Antigravity
started from the Dock still finds Node, Flutter and Xcode. `baton setup antigravity --remove`
removes it.

`baton setup` only touches Antigravity when `~/.gemini/antigravity` exists.

## Manual setup

`~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.10"] }
  }
}
```

## Verify

1. Restart Antigravity, or refresh the MCP servers list in its agent panel.
2. `baton` should be listed with its tools.
3. Ask the agent: "Use Baton to inspect this project and list its targets."

## Troubleshooting

- **Server fails to start**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.10 baton doctor` in a terminal to see the cause.
- **"npx: command not found" or SDKs not found**: the app has a short `PATH`. Add
  `"env": { "PATH": "<output of echo $PATH>" }` to the entry, or use `baton setup antigravity`.
- **`setup` says "not installed"**: open Antigravity once so it creates
  `~/.gemini/antigravity`, then run it again.
