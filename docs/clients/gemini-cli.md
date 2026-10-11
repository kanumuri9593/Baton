# Baton in Gemini CLI

## One command

```bash
npm install -g baton-run
baton setup gemini
```

This adds a `baton` entry under `mcpServers` in `~/.gemini/settings.json`, leaves your other
settings alone, and saves the previous file as `settings.json.baton-backup`. The entry starts
this install by absolute path, carries your shell's `PATH`, and sets `"timeout": 900000`
(15 minutes) for long native builds. `baton setup gemini --remove` removes it.

`baton setup` treats Gemini CLI as installed when `gemini` is on your `PATH` or
`~/.gemini/settings.json` exists.

## Manual setup

`~/.gemini/settings.json`, or `.gemini/settings.json` in one project:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"], "timeout": 900000 }
  }
}
```

Merge the `baton` entry into an existing `mcpServers` object rather than replacing the file.

## Verify

1. Start `gemini` and run `/mcp`. `baton` should be listed as connected, with its tools.
2. Ask: "Use Baton to inspect this project and list its targets."

## Troubleshooting

- **`baton` disconnected in `/mcp`**: Baton needs Node.js 24+. Run
  `npx -y --package=baton-run@0.2.9 baton doctor` to see the cause.
- **`setup` skipped Gemini with "is not plain JSON"**: `settings.json` has comments. Add the
  entry by hand.
- **Tool calls time out during a first iOS or Android build**: keep `"timeout": 900000`.
- **Agent runs `flutter run` in a shell instead**: add the loop from
  [docs/clients.md](../clients.md#the-loop-to-teach-your-agent) to `GEMINI.md`.
