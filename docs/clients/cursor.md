# Baton in Cursor

## One command

```bash
npm install -g baton-run
baton setup cursor
```

This adds a `baton` entry under `mcpServers` in `~/.cursor/mcp.json` (every project), leaves
other servers alone, and saves the previous file as `mcp.json.baton-backup`. The entry starts
this install by absolute path (`node …/bin/baton-mcp.js`) and carries your shell's `PATH`,
because Cursor started from the Dock often has no `npx`, `flutter` or `xcrun` on its own
`PATH`. `baton setup cursor --remove` removes it.

## Manual setup

`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.10"] }
  }
}
```

If Cursor cannot find `npx` or your SDKs, add `"env": { "PATH": "<output of echo $PATH>" }` to
the entry, or use `baton setup cursor`, which does that for you.

## Verify

1. Restart Cursor, or reload MCP servers in Cursor's settings.
2. In Cursor's MCP settings, `baton` should show as enabled with its tools listed.
3. In agent mode, ask: "Use Baton to inspect this project and list its targets."

## Troubleshooting

- **`baton` shows an error in settings**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.10 baton doctor` in a terminal to see the cause.
- **`setup` skipped Cursor with "is not plain JSON"**: `mcp.json` has comments or trailing
  commas. Add the entry by hand.
- **Runs fail with "flutter: command not found"**: the server inherited Cursor's short `PATH`.
  Add an `env.PATH` as above.
- **Agent never calls Baton**: add the loop from
  [docs/clients.md](../clients.md#the-loop-to-teach-your-agent) to your project rules.
