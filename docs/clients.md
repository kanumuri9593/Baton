# Connect Baton to your agent

Baton is one MCP server, `baton-run` on npm. Every client below starts it the same way:
`npx -y baton-run@0.2.9`. The first call downloads it (about a minute); after that it starts
in under a second. Requires **Node.js 24+** on the machine that runs your apps.

Prefer a global install? `npm install -g baton-run`, then use `baton-mcp` as the command
with no arguments.

## One command for every tool

```bash
npm install -g baton-run
baton setup
```

`baton setup` finds the coding agents installed on this machine and adds Baton to each one:
Claude Code (the plugin), Codex, Cursor, VS Code, Antigravity, Gemini CLI and Windsurf. It
edits only the `baton` entry, keeps a `.baton-backup` of every file it changes, and is safe to
run again. Name tools to limit it (`baton setup cursor codex`), preview with `--dry-run`, and
undo with `--remove`. It writes the absolute path of this install and your shell's `PATH`,
so apps started from the Dock still find Node, Flutter and Xcode.

Restart the app (or open a new chat) afterwards. The sections below are the same entries,
for setting a tool up by hand.

Long steps (a first iOS build, `run_proof` across devices) can take several minutes. Where a
client has a per-tool timeout, the snippets below raise it to 15 minutes.

## Claude Code

The plugin adds the server, a skill that teaches the loop, `/baton:run`, `/baton:doctor`, a
live band above the prompt in the terminal, and the "show Baton" card in the desktop app:

```
/plugin marketplace add kanumuri9593/Baton
/plugin install baton@baton
```

Server only:

```bash
claude mcp add baton -- npx -y baton-run@0.2.9
```

## Codex

The Codex plugin adds Baton's skills (how to run, reload and check an app) next to the server:

```bash
codex plugin marketplace add kanumuri9593/Baton
codex plugin add baton@baton
```

Codex keeps MCP tools out of the prompt until it looks for them, so the skill is what makes
"run my app" reach Baton. Server only, in `~/.codex/config.toml`:

```toml
[mcp_servers.baton]
command = "npx"
args = ["-y", "baton-run@0.2.9"]
tool_timeout_sec = 900
```

## Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
  }
}
```

## VS Code

Claude Code in VS Code uses the same plugin as the terminal: install it there and `/baton`
opens the control panel beside the chat. For GitHub Copilot agent mode, add the server to
`.vscode/mcp.json` (or your user `mcp.json`):

```json
{
  "servers": {
    "baton": { "type": "stdio", "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
  }
}
```

## Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in the project):

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"], "timeout": 900000 }
  }
}
```

## Antigravity

`~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
  }
}
```

## Claude Desktop and anything else

Any client that takes an `mcpServers` block:

```json
{
  "mcpServers": {
    "baton": { "command": "npx", "args": ["-y", "baton-run@0.2.9"] }
  }
}
```

Agents without MCP can use the CLI: `npx -y --package=baton-run@0.2.9 baton <command>`. Every
command exits non-zero on failure, and `baton check <session> --json` gives the same verdict
as the `check_change` tool.

## The loop to teach your agent

Paste this into `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or your rules file:

```markdown
## Running the app
Use the Baton MCP tools, not raw `flutter run` / `npm run dev` in a shell.
1. `inspect_project` and `list_targets` with cwd set to the absolute project path.
2. `run_target` (or `run_workflow` for API + frontend), then `wait_for`.
   No simulator up? `boot_device` first.
3. After every edit: `check_change`. Fix anything it reports as NOT OK and call it again.
   For web apps pass `viewport: "phone"` to check the mobile layout too.
4. Look at the screenshot and say what you see. A capture is not proof the UI is right.
```

## Pairs well with

Baton runs the app and reports what happened. It does not tap or type. When a check needs
input (log in, fill a form, tap through onboarding), add one of these next to it:

- Web: Playwright MCP or Chrome DevTools MCP, pointed at the session URL Baton returns.
- iOS and Android: a device-control MCP such as mobile-mcp, on the simulator Baton booted.
