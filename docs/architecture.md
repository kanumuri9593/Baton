# Baton architecture

Baton is a local execution layer shared by people, scripts, and any compatible
agent. One loopback daemon owns all running sessions. The CLI, control panel,
and MCP server are clients of that same state.

```text
launch.json / package.json / pubspec.yaml
                    │
             project detection
                    │
 CLI ───────┐       ▼
 MCP ───────┼── loopback daemon ── adapters ── app processes
 Baton app ─┘       │                 │
                    ├── sessions      ├── Flutter daemon protocol
                    ├── run history   ├── web dev servers
                    ├── devices       ├── React Native / Metro
                    ├── checkouts     └── generic processes
                    ├── network evidence
                    └── proof bundles
```

## Subsystem map

| Area | Source | Responsibility |
|---|---|---|
| CLI | `src/cli/` | Human/script commands and daemon lifecycle |
| MCP | `src/mcp/` | Structured tools for any MCP-compatible agent |
| Daemon | `src/daemon/` | Authenticated loopback RPC, workflows, devices, evidence, proofs |
| Core | `src/core/` | Sessions, registry, projects, checkouts, history, shared types |
| Adapters | `src/adapters/` | Framework-specific start/reload/restart behavior |
| Control panel | `src/hud/assets/` | Browser UI shared by macOS and other platforms |
| macOS host | `hud/mac/` | Menu bar, Dock, floating launcher, window behavior, login item |
| Configuration | `src/config/` | Detection, validation, and comment-preserving launch-file edits |
| Instrumentation | `src/instrumentation/`, `src/vm/` | Node and Flutter request evidence |
| Examples | `examples/` | Credential-free Flutter and multi-project workflow labs |
| Tests | `test/` | Cross-platform protocol, package, UI contract, and integration coverage |

## State and trust boundaries

- The daemon binds only to `127.0.0.1` and requires the random token stored in
  `~/.baton/daemon.json` with mode `0600`.
- Long-running session metadata and logs live under `~/.baton`; project source
  remains in its repository or an explicit git worktree.
- The control panel is served with `Cache-Control: no-store` and loads no remote
  scripts. Non-secret UI preferences are local to its WebKit/browser store.
- Baton reads `.vscode/launch.json` and `.claude/launch.json` for compatibility;
  neither file format implies or requires a particular editor or model.
- MCP is the vendor-neutral automation boundary. Baton does not depend on one
  model provider and should describe integrations by protocol capability.
- Automated development assistance is attributed to the project owner through
  `.mailmap`; the public contributor identity does not advertise one model or
  editor as if Baton depended on it.

## Release path

`npm ci` → build → typecheck → test → `npm pack --dry-run` is the local release
contract. Publishing is triggered by a GitHub release whose tag exactly matches
the package version and uses npm provenance.
