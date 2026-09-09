# Baton for coding agents

Baton is an MCP server, CLI, and floating HUD. Install it once on the machine that runs the apps. Then any MCP client (Claude Code, Cursor, Codex, Gemini CLI, Windsurf, and others) can list targets, run them, hot-reload, read logs, boot simulators, and capture screenshots.

Requires **Node.js 24+**. The daemon listens on loopback only.

## Install

**Clone and build** (works today):

```bash
git clone https://github.com/kanumuri9593/Baton.git && cd Baton
npm install && npm run build
npm link        # makes baton, baton-daemon, baton-mcp available globally
```

Or run directly without linking: `node bin/baton.js …`

**npm** (once published — 404 until v0.2.1 ships):

```bash
npm install -g baton-run
```

> **Do not** use `npm install -g github:kanumuri9593/Baton` without building first — npm does not run the build step, leaving `dist/` missing.

The commands are `baton`, `baton-daemon`, and `baton-mcp`.

## The HUD

There is **no separate App Store binary** or "Baton HUD" download. The HUD is `baton hud`:

- **macOS**: native floating panel + menu-bar item. First run compiles the panel from `hud/` (needs Xcode or Command Line Tools).
- **Linux / Windows**: chromeless browser window.

```bash
baton hud
```

### Troubleshooting: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING

If `baton` crashes with this error, you have an old `baton-run@0.2.0` that tried to import `.ts` files. Fix:

```bash
npm uninstall -g baton-run
# Reinstall from a built clone (above), or wait for baton-run@0.2.1+ on npm
```

## MCP (preferred)

Point the client at `baton-mcp`. The first tool call starts the daemon if needed.

**Claude Code** (after `npm link` from a built clone):

```bash
claude mcp add baton -- baton-mcp
```

**Cursor / Windsurf / Claude Desktop / Codex / Gemini CLI** — add to the client's MCP config (after global install via `npm link`):

```json
{
  "mcpServers": {
    "baton": {
      "command": "baton-mcp"
    }
  }
}
```

Once `baton-run` is published to npm (v0.2.1+), you can use npx without a global install:

```json
{
  "mcpServers": {
    "baton": {
      "command": "npx",
      "args": ["-y", "baton-run", "baton-mcp"]
    }
  }
}
```

> **Note:** Never use bare `npx baton-mcp` — always specify the package: `npx -y baton-run baton-mcp`.

## Tools

`inspect_project`, `list_targets`, `list_sessions`, `list_checkouts`, `list_devices`, `run_target`, `run_workflow`, `hot_reload`, `hot_restart`, `stop_session`, `forget_session`, `wait_for`, `read_logs`, `session_summary`, `screenshot`, `set_debug_flag`, `diagnose`, `list_network_requests`, `get_network_request`, `clear_network_requests`, `read_launch_config`, `write_launch_config`, `run_proof`, `list_proofs`, `list_run_history`.

Typical loop: `inspect_project` → `run_target` or `run_workflow` → `wait_for` → exercise the app with browser/device tools → `screenshot` / `read_logs` / `diagnose` → edit → `hot_reload`.

Baton launches and reports evidence. It does not tap the UI or judge screenshots. Treat capture success as “an image was written”, not visual correctness.

**Current limitations:** MCP cannot boot simulators or emulators. Use CLI `baton boot "iPhone 17 Pro"` or target a device that is already running. `run_target` waits only briefly for a device to appear; if none is available, it fails. A `boot_device` MCP tool is planned.

## CLI fallback

Agents that cannot speak MCP can shell out. Commands exit non-zero on failure.

```bash
baton doctor --json
baton list
baton run "<target>" --branch origin/main
baton reload --all
baton logs "<session>" -n 80
baton diagnose
baton workflow /absolute/path/to/workflow.json
```

## Safety

The daemon binds `127.0.0.1` and authenticates with a token in `~/.baton/daemon.json` (mode 0600). Do not expose the port. Do not put secrets in launch files that will be committed.
