# Baton in Claude Desktop

This page is about the chat in the Claude desktop app. For Claude Code (including Claude Code
inside the desktop app), use the plugin: [claude-code.md](claude-code.md).

## One command

There isn't one. `baton setup` leaves Claude Desktop out on purpose: the running app rewrites
`claude_desktop_config.json` and can drop a server that was added behind its back. Add Baton
by hand, with the app closed.

## Manual setup

1. Quit Claude Desktop completely (on macOS, **Claude → Quit**, not just closing the window).
2. Open the config file, creating it if needed:

   | OS | File |
   |---|---|
   | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

3. Add `baton` to `mcpServers`, keeping any other entries:

   ```json
   {
     "mcpServers": {
       "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
     }
   }
   ```

4. Start Claude Desktop again.

The app starts servers with a short `PATH`. If it cannot find `npx`, or Baton cannot find
Flutter or Xcode, use absolute paths and pass your shell's `PATH`:

```json
{
  "mcpServers": {
    "baton": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/baton-run/bin/baton-mcp.js"],
      "env": { "PATH": "<output of echo $PATH>" }
    }
  }
}
```

Use `which node` and `npm root -g` to find the real paths on your machine.

## Verify

1. In a new chat, open the tools menu: Baton's tools should be listed.
2. Ask: "Show Baton." Claude calls `show_dashboard`, which draws a live card with your runs.

## Troubleshooting

- **Baton disappeared after editing**: the app was running and rewrote the file. Quit it, add
  the entry again, then start it.
- **Server error on start**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.9 baton doctor` in a terminal to see the cause. Claude
  Desktop's MCP logs are in its developer settings.
- **"spawn npx ENOENT"**: use the absolute-path form above.
