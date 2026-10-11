# Baton in VS Code

There are two ways to use Baton in VS Code:

- **Claude Code extension**: uses the same plugin as the terminal, including `/baton` beside
  the chat. See [claude-code.md](claude-code.md).
- **GitHub Copilot agent mode**: add Baton as an MCP server, as below.

## One command

```bash
npm install -g baton-run
baton setup vscode
```

This adds a `baton` entry under `servers` in your user `mcp.json`, leaves other servers alone,
and saves the previous file as `mcp.json.baton-backup`:

| OS | File |
|---|---|
| macOS | `~/Library/Application Support/Code/User/mcp.json` |
| Linux | `~/.config/Code/User/mcp.json` (or `$XDG_CONFIG_HOME/Code/User/mcp.json`) |
| Windows | `%APPDATA%\Code\User\mcp.json` |

The entry starts this install by absolute path and carries your shell's `PATH`, so VS Code
started from the Dock still finds Node, Flutter and Xcode. `baton setup vscode --remove`
removes it.

## Manual setup

User `mcp.json` (the files above), or `.vscode/mcp.json` in one workspace. VS Code uses a
`servers` key and a `type`:

```json
{
  "servers": {
    "baton": { "type": "stdio", "command": "npx", "args": ["-y", "baton-run@0.2.10"] }
  }
}
```

## Verify

1. Run **MCP: List Servers** from the Command Palette. `baton` should be listed and running.
2. Open Copilot Chat in **Agent** mode and check the tools picker includes Baton's tools.
3. Ask: "Use Baton to inspect this project and list its targets."

## Troubleshooting

- **Server not listed**: make sure the file uses `servers`, not `mcpServers`, and that the
  entry has `"type": "stdio"`.
- **Server fails to start**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.10 baton doctor` in a terminal to see the cause. Use the
  server's **Show Output** action for its log.
- **`setup` skipped VS Code with "is not plain JSON"**: `mcp.json` has comments. Add the entry
  by hand.
- **Tools not offered in chat**: Copilot only uses MCP tools in Agent mode.
