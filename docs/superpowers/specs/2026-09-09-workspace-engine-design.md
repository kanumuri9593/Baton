# Baton workspaces: from single runs to a mapped local system

Date: 2026-09-09
Status: approved. Implementation plan: [../plans/2026-09-09-workspace-engine.md](../plans/2026-09-09-workspace-engine.md)

## Context

Baton 0.2.6 runs one target at a time well: one loopback daemon, adapters for Flutter, web dev
servers, React Native, native iOS/Android and plain processes; checkouts/worktrees; log history;
network capture (Flutter VM service, Node OpenTelemetry via `batonTrace`); Diagnose → Follow trace;
proof bundles; a HUD/app with a project rail.

The multi-service story is thin. `workflow.json` is a flat, strictly sequential list of up to 8
`cwd + target` steps (`src/daemon/workflow.ts`). It has no dependency graph, no env wiring between
steps, no notion of databases, containers or remote endpoints, and readiness is log-regex only
(`src/adapters/web-dev.ts`); the `port` field in launch.json is parsed but never used. The app
already labels a workflow group "workspace" (`src/hud/assets/workspace.js`), so the UI is ahead of
the engine.

The goal is the vision the user described and `MASTER_PLAN.md` already calls Phase 3: a team can
point Baton at a whole project (mobile app + backend + data stores + web app), bring it up locally
with one action, see the pieces and how they talk to each other on one map, flip any piece between
local, Docker, and a named cloud endpoint with a click, and walk away with proof to attach to a PR.

Decisions taken during brainstorming:

- Not specific to one project; any repo layout.
- Map edges = declared dependencies as the skeleton, lit up by live captured traffic.
- Local ↔ cloud is a **per-node provider switch**; dependents restart to pick up new env.
- Baton **attaches proof** to PRs; it does not open PRs.
- Workspaces are **discovered, then saved** to a committed `baton.workspace.json`.
- Approach A: grow the existing workflow into a service graph inside the daemon. Not compose-first,
  not a separate orchestrator.
- Build order: 1 engine → 2 topology view → 3 discovery → 4 workspace proof.

## Decomposition (four sub-projects, each its own spec → plan → implementation)

1. **Workspace engine** (this plan). Manifest, providers (target/compose/remote), real readiness
   probes, dependency-ordered parallel start, provider switch, `baton up/down/status/switch/restart`,
   RPC + push + MCP, node rows in the app. No graph drawing.
2. **Topology view.** SVG graph in the app. Declared edges; live request counts/errors overlaid by
   matching captured request host:port to node endpoints; click a node to start/stop/switch.
3. **Discovery → manifest.** Scan added folders (launch.json targets, package scripts, compose files,
   Flutter/native projects), propose nodes and edges, confirm/edit in the app, write the manifest.
4. **Workspace proof.** Bundle with `topology.json`, per-node health, request-flow summary,
   screenshots, and a `summary.md` written to paste into a PR body. MCP `run_workspace_proof`.

---

# Sub-project 1 spec: workspace engine

## 1. Manifest and data model

`baton.workspace.json`, committed at an umbrella folder (monorepo root, or a folder that only holds
the manifest and points at sibling repos). It composes existing config: launch targets stay in each
project's launch.json; containers stay in Compose files.

```jsonc
{
  "name": "Delivery",
  "nodes": {
    "postgres": {
      "kind": "datastore",
      "providers": {
        "docker":  { "compose": { "file": "./infra/docker-compose.yml", "service": "postgres" },
                     "ready": { "tcp": 5432 } },
        "staging": { "remote": { "url": "postgres://staging-db:5432/app" } }
      },
      "exports": { "DATABASE_URL": "${url}" }
    },
    "api": {
      "kind": "backend",
      "dependsOn": ["postgres"],
      "providers": {
        "local": { "target": { "cwd": "./api", "name": "Delivery API" },
                   "url": "http://127.0.0.1:43121",
                   "ready": { "http": "http://127.0.0.1:43121/health" } },
        "dev":   { "remote": { "url": "https://api.dev.example.com" } }
      },
      "exports": { "API_URL": "${url}" }
    },
    "console":    { "kind": "web",    "dependsOn": ["api"],
                    "providers": { "local": { "target": { "cwd": "./console", "name": "Delivery console" }, "ready": "url" } } },
    "driver-app": { "kind": "mobile", "dependsOn": ["api"],
                    "providers": { "local": { "target": { "cwd": "./mobile", "name": "iOS Simulator (DEV)" } } } }
  },
  "defaults": { "postgres": "docker", "api": "local" }
}
```

- **Node**: `kind` (`backend | web | mobile | datastore | queue | other`, display only),
  `dependsOn: string[]`, `providers`, `exports`.
- **Provider**: exactly one of `target { cwd, name, branch?, checkout?, device? }`,
  `compose { file, service }`, `remote { url }`. Optional `url` (explicit), `ready`, `timeoutMs`
  (default 60 000, cap 300 000, same as the waiter).
- **Readiness**: `"running" | "url" | { tcp: number } | { http: string, status?: number } | { log: string }`.
  This also gives `wait` TCP/HTTP conditions and finally uses the `port` field.
- **Exports**: env a node offers to dependents, templated from the active provider's resolved
  `${url}`. Merged over the dependent's launch env. Flutter targets receive them as
  `--dart-define=K=V` because env does not reach a Flutter app.
- **defaults**: the team's default provider per node. Per-machine last choice lives in
  `~/.baton/workspaces.json`, not in the committed file.
- Limit 24 nodes. Paths relative to the manifest file.

Runtime state, in-memory in the daemon like sessions:

```ts
type WorkspaceRun = { id: string; name: string; manifestPath: string; root: string; startedAt: number;
                      nodes: Record<string, NodeState> };
type NodeState = { name: string; kind: NodeKind; provider: string; dependsOn: string[];
                   status: 'pending' | 'starting' | 'ready' | 'unhealthy' | 'failed' | 'skipped' | 'stopped' | 'external';
                   sessionId?: string; url?: string; error?: string; readOnly: boolean };
```

Sessions started by a workspace carry `workspace: { id, node }` on `SessionSnapshot`; the existing
`workflow` string is still set (to the workspace name) so current clients keep grouping.

## 2. Engine behavior

- **Validate first**: every `dependsOn` exists, no cycles, each provider has exactly one of
  target/compose/remote, chosen providers exist. Nothing starts if validation fails.
- **Bring-up**: topological levels; nodes within a level start in parallel.
  - `remote` → probe if declared → `external`. Never started or stopped.
  - `compose` → `docker compose -f <file> up -d <service>` via a new `compose` session kind; logs
    via `docker compose logs -f <service>`; then probe. If the container was already running before
    Baton, mark `external` and leave it alone on `down`.
  - `target` → resolve checkout, detect targets in that cwd, merge dependencies' exports over the
    launch env, `registry.run` exactly as the `run` RPC does, then wait on declared readiness.
- **Failure attribution**: a failed node marks transitive dependents `skipped` with text naming the
  culprit ("console skipped: api failed (http://127.0.0.1:43121/health never answered within 60s)").
  Independent branches keep starting.
- **Reuse, don't refuse**: a live session with the node's id is adopted. `up` is idempotent: it
  starts only pending/stopped/failed nodes.
- **Ownership**: Baton stops only what it started. `down` walks reverse topological order. Remote and
  external nodes are untouched and excluded from Stop-all.
- **Switch(node, provider)**: stop the old owned provider, start the new one, wait ready, restart
  dependents in topological order (skip remote/external). Persist the choice per machine.
- **Restart(node, cascade?)**: node only by default; `cascade` also restarts dependents via the same
  path as switch.
- **Ongoing health**: after `ready`, re-probe every 15 s. Fail → `unhealthy` (nothing stopped);
  pass → `ready`. Remote nodes too.
- One `WorkspaceRun` per manifest path at a time.

## 3. Surfaces

**CLI**
```
baton up [dir|manifest] [--provider postgres=staging] [--node api]
baton down [dir|manifest]
baton status [dir|manifest]           # node · provider · status · url · session
baton switch <node> <provider>
baton restart <node> [--cascade]
```
`baton workflow <file>` still works: `workflow.json` is converted in memory to a linear manifest.

**RPC** (`src/core/api.ts`): `workspaceUp { manifest | cwd, nodes?, providers? }`, `workspaceDown { id }`,
`workspaceStatus { id? }`, `workspaceSwitch { id, node, provider }`, `workspaceRestart { id, node, cascade? }`.
Push `{ event: 'workspace', run: WorkspaceRun }` on any node change. `wait` gains `{ tcp }` / `{ http }`.

**MCP**: `start_workspace`, `stop_workspace`, `workspace_status`, `switch_provider`, `restart_node`.
`run_workflow` stays, documented as the legacy flat form. Results are structured with a `next` hint.

**App** (no graph yet): an added project root containing `baton.workspace.json` shows as a workspace
entry in the rail. The workspace pack renders node rows: status dot, provider dropdown (→
`workspaceSwitch`), URL, per-node start/stop/restart, workspace-level Up/Down. Remote/external rows
are tagged and have no stop control.

## 4. Errors

| What happened | What you see |
|---|---|
| Invalid manifest | `up` refuses with file, node, reason. Nothing starts. |
| Docker not installed | Compose nodes fail: "docker not found; install Docker or switch postgres to another provider". Dependents skipped. |
| Compose file or service missing | Same shape, naming file and service. |
| Probe timeout | Node `failed` with probe description and last error lines from its log. |
| Remote unreachable at `up` | Node `failed`, dependents skipped. |
| Node session already live outside the workspace | Adopted, not refused. |
| `down` with external nodes | Success plus "left running: postgres (external)". |

## 5. Testing

Repo conventions: `node:test`, `BATON_HOME` temp dir before dynamic import, injection over mocks,
no Docker or simulator in CI.

- Pure: manifest validation (cycles, unknown deps, provider shape, defaults), topological levels,
  export templating, workflow.json → manifest conversion.
- Engine with a fake host (like `WorkflowHost`): parallel within a level, skip attribution text,
  idempotent `up`, reverse-order `down`, switch restarts only dependents, external never stopped.
- Probes against an ephemeral local TCP/HTTP server, including timeout.
- Compose adapter with injected `spawnFn`, asserting exact `docker compose` argv.
- End-to-end: `examples/workflow-lab/baton.workspace.json` through the real daemon, like
  `test/delivery-demo.test.ts`.
- HUD asset text contracts, as in `test/hud.test.ts`.

## Out of scope for sub-project 1

Topology drawing; discovery/manifest generation; workspace proof bundle; PR creation; Compose
networks or volumes management; secrets handling beyond passing env; Windows Docker specifics
beyond spawn shims already in `process.ts`.

---

