# Baton for coding agents

Baton is an MCP server, CLI, and local control panel. Install it once on the machine that runs the apps. Then any MCP-compatible client can list targets, run them, hot-reload, read logs, boot simulators, and capture screenshots.

Requires **Node.js 24+**. The daemon listens on loopback only.

## Install

```bash
npm install -g github:kanumuri9593/Baton#v0.2.6
```

```bash
npm install -g baton-run
```

The commands are `baton`, `baton-daemon`, and `baton-mcp`. Open the app with `baton app` (native panel on macOS, browser window elsewhere). `baton hud` remains a compatibility alias. There is no separate App Store binary.

## MCP (preferred)

Point the client at `baton-mcp`. The first tool call starts the daemon if needed.

Add `baton-mcp` to any client's MCP server configuration:

```json
{
  "mcpServers": {
    "baton": {
      "command": "baton-mcp"
    }
  }
}
```

Without a global install:

```json
{
  "mcpServers": {
    "baton": {
      "command": "npx",
      "args": ["-y", "--package=github:kanumuri9593/Baton#v0.2.6", "baton-mcp"]
    }
  }
}
```

## Tools

`inspect_project`, `list_targets`, `list_sessions`, `list_checkouts`, `list_devices`, `run_target`, `start_workspace`, `stop_workspace`, `workspace_status`, `switch_provider`, `restart_node`, `run_workflow`, `hot_reload`, `hot_restart`, `stop_session`, `forget_session`, `wait_for`, `read_logs`, `session_summary`, `screenshot`, `set_debug_flag`, `diagnose`, `list_network_requests`, `get_network_request`, `clear_network_requests`, `read_launch_config`, `write_launch_config`, `run_proof`, `list_proofs`, `list_run_history`.

Typical loop: `inspect_project` → `run_target` or `start_workspace` → `wait_for` → exercise the app with browser/device tools → `screenshot` / `read_logs` / `diagnose` → edit → `hot_reload`.

## Workspaces

A repository with a `baton.workspace.json` describes a whole local system: databases, containers, APIs, web and mobile apps, and what depends on what. `start_workspace` brings it up in dependency order, in parallel where safe, and blocks until every node has settled — do not poll it. Each node reports its provider, status, URL and session id; a failed node says why, and its dependents name the node that took them down.

Each node offers one or more **providers**: a launch target, a Docker Compose service, or a named remote endpoint. `switch_provider` points a node at a different one and restarts its dependents so they pick up the new address. A node's `exports` become environment variables for its dependents (and `--dart-define`s for Flutter, which cannot read environment).

Baton stops only what it started. A remote endpoint, or a container that was already running when Baton looked, comes back as `external`: usable, reported, and never stopped — `stop_workspace` names those in `left` rather than pretending it stopped them.

`run_workflow` still works and is the legacy flat form: a strictly sequential list with no graph, providers or probes.

Opening an Xcode or Gradle folder (or `.xcodeproj`, `project.pbxproj`, `settings.gradle(.kts)`, `gradlew`, `AndroidManifest.xml`) is a native `ios`/`android` target: Baton builds, installs and launches on the selected simulator or device, then follows logs. Restart rebuilds and relaunches. It is not Flutter hot reload. Nested `ios/` and `android/` under a Flutter or React Native root are recognised when that folder is the project; the framework root still runs the framework.

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
baton up /absolute/path/to/workspace     # or any directory beneath it
baton status                             # node · provider · status · url
baton switch postgres staging
baton down /absolute/path/to/workspace
```

## Safety

The daemon binds `127.0.0.1` and authenticates with a token in `~/.baton/daemon.json` (mode 0600). Do not expose the port. Do not put secrets in launch files that will be committed.
