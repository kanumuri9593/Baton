# Baton in Windsurf

## One command

```bash
npm install -g baton-run
baton setup windsurf
```

This adds a `baton` entry under `mcpServers` in `~/.codeium/windsurf/mcp_config.json`, leaves
other servers alone, and saves the previous file as `mcp_config.json.baton-backup`. The entry
starts this install by absolute path and carries your shell's `PATH`, so Windsurf started from
the Dock still finds Node, Flutter and Xcode. `baton setup windsurf --remove` removes it.

`baton setup` only touches Windsurf when `~/.codeium/windsurf` exists.

## Manual setup

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
  }
}
```

## Verify

1. Restart Windsurf, or refresh the MCP servers in Cascade's MCP settings.
2. `baton` should be listed and enabled, with its tools.
3. Ask Cascade: "Use Baton to inspect this project and list its targets."

## Troubleshooting

- **Server fails to start**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.9 baton doctor` in a terminal to see the cause.
- **"npx: command not found" or SDKs not found**: add
  `"env": { "PATH": "<output of echo $PATH>" }` to the entry, or use `baton setup windsurf`.
- **`setup` skipped Windsurf with "is not plain JSON"**: the file has comments. Add the entry
  by hand.
