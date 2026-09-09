# Workspace engine — implementation plan

Date: 2026-09-09  
Spec: [2026-09-09-workspace-engine-design.md](../specs/2026-09-09-workspace-engine-design.md)


Follow the steps below with TDD; each step leaves `npm test` green. The spec is committed alongside this plan.

## Architecture in one picture

```
baton.workspace.json ─parseManifest─▶ WorkspaceManifest ─validateGraph─▶ topo levels
CLI / MCP / HUD ─RPC workspace*─▶ LaunchDaemon.handle()
                                       │
                          WorkspaceEngine (src/workspace/engine.ts) — Map<manifestPath, WorkspaceRun>
                                       │ WorkspaceHost (injected)
            ┌──────────────────────────┼──────────────────────────┐
     target provider            compose provider             remote provider
 daemon.#runTarget → registry   ComposeSession → registry.own   probes.pollProbe (no session) → external
 waitForSession(until)          waitForSession('running'|probe)
```

Everything under `handle()` is injected: engine sees a `WorkspaceHost`; compose adapter sees
`spawnFn`; probes take `probeFn`/interval. Engine `change` → `#broadcast({event:'workspace', run})`.

## Key design decisions (from planning)

- **Compose is a provider, not a `TargetKind`.** Adding a kind would ripple through `detect.ts`,
  `loader.ts`, `writer.ts`, `guide.ts`, `compactMark`. `ComposeSession extends BaseSession`
  (`kind = 'compose'`) is registered through a new `SessionRegistry.own(session, options)` that
  `run()` also delegates to.
- **Shared `#runTarget`, not `this.handle({method:'run'})`.** Extract the body of the `run` case in
  `src/daemon/server.ts` (~L500-537) into `#runTarget(params & { env?, workspace?, ifRunning? })`
  returning the live `Session`. The public `run` RPC must not accept `workspace`/`env` from clients.
- **Env injection lives in `SessionRegistry.#create`** via new `RunOptions.env`: merged over
  `target.config.env` for process/web-dev/react-native/ios/android; for Flutter, clone config with
  merged env and `toolArgs += toDartDefines(env)` (`buildFlutterArgv` in `loader.ts` already appends
  `toolArgs`). Zero adapter edits.
- **Duplicate ids.** `registry.adopt` refuses duplicates (`registry.ts` L99-103). Add: terminal
  duplicate → evict and emit `'forgotten'` (daemon cleans up like `#forgetSession` and broadcasts);
  live duplicate with `ifRunning: 'reuse'` → return existing. Restarts with new env must go
  stop → evict → `registry.run`, never `hotRestart` (it reuses the old env, `process.ts` L139-143).
- **Probes in `src/daemon/probes.ts`**, not inside waiter, because remote nodes and the health loop
  have no session. `waitForSession` gains probe `until`s: still subscribes to `change`/`exit` for the
  early "impossible" failure, plus `pollProbe` with an `AbortSignal` cancelled in `cleanup()`.
  `{http}` without `status` = any HTTP response counts as up; `{tcp}` connects to `127.0.0.1:port`.
- **Compose lifecycle.** `ps --format json --status running <service>` non-empty → `external`.
  Else `up -d <service>` (exit≠0 → failed with stderr), then `logs -f --no-log-prefix <service>` as
  the long-lived child; status tied to `up` exit code and the `logs` child, never to `up -d` exiting.
  `ENOENT` → failed with `DOCKER_MISSING_HINT` (mentions Compose v2 requirement and `baton switch`).
  `stop()` runs `compose stop <service>` only when not external. `shell: false` on every platform.
- **Legacy workflow.** `workflowRun` RPC and `run_workflow` MCP keep identical params/results via
  `workflowToManifest` (node *i* dependsOn node *i-1*) + `toWorkflowResult`. `runWorkflow` and
  `WorkflowHost` are deleted; `parseWorkflow` stays.
- **CLI collisions.** `baton status` (session summary) and `baton restart` exist. `status` with no
  arg or a dir/manifest → workspace status, otherwise fall back to summary. `restart <name>` →
  workspace node if the cwd's manifest has a live run with that node, else session; `--cascade`
  forces workspace. Document in HELP.
- Warn (diagnostic, not error) when a `backend|datastore|queue` node uses `ready: 'running'`, since
  `ProcessSession` is `running` the instant it spawns (`process.ts` L119-124).

## Files

New (`src/workspace/` unless noted):
- `types.ts` — `NodeStatus`, `NodeState`, `WorkspaceRun`, `WorkspaceUpOptions`, `WorkspaceDownResult`.
- `manifest.ts` — zod schema, `parseManifest(input, baseDir)`, `findManifest`, `readManifest`,
  `chosenProvider(manifest, node, overrides, persisted)` (override > persisted > defaults > sole provider).
- `graph.ts` — `validateGraph` (unknown/self dep, cycle path, export-key collision among a node's deps),
  `topoLevels`, `dependentsOf`, `reverseTopo`.
- `exports.ts` — `renderExports`, `dependencyEnv` (direct deps, declared order), `toDartDefines`.
- `choices.ts` — `WorkspaceChoices` over `~/.baton/workspaces.json` (robust like `ProjectRegistry`).
- `engine.ts` (~300) + `health.ts` — `WorkspaceEngine { up, down, switch, restart, status, get, dispose }`,
  `NodeHealth` re-probe loop (interval injectable, timers `unref()`).
- `convert.ts` — `workflowToManifest`, `toWorkflowResult`.
- `src/daemon/probes.ts` — `probeOnce`, `pollProbe`, `describeProbe`, `isProbe`.
- `src/daemon/workspace-host.ts` — `createWorkspaceHost({ runTarget, registry, checkouts, broadcast, recentErrors })`.
- `src/adapters/compose.ts` — `ComposeSession`.
- `src/hud/assets/workspace-pane.js` — node rows, provider dropdown, Up/Down; sole caller of the
  `workspace*` RPCs, registered through `window.baton.extend` like `editor.js`.
- `examples/workflow-lab/baton.workspace.json`.

Modified: `src/core/types.ts` (+`workspace?: {id,node}`), `src/core/session-base.ts`,
`src/core/registry.ts`, `src/core/paths.ts` (`workspacesStorePath`), `src/daemon/waiter.ts`,
`src/core/api.ts` (RPC methods, push event, `hello.workspaces`, `ProjectInfo.workspace`),
`src/daemon/server.ts`, `src/daemon/workflow.ts`, `src/cli/index.ts`, `src/mcp/index.ts`,
`src/hud/render.ts` (asset allowlist), `src/hud/assets/{index.html,core.js,workspace.js,workspace.d.ts,hud.css}`,
`package.json` (`files`), `examples/workflow-lab/console/server.mjs` (print bound port so `PORT=0`
is truthful), docs (`AGENTS.md`, `README.md`, `docs/launch-guide.md`, `llms.txt`, example README).

## Steps (suite green after each)

1. **Pure core**: `types`, `manifest`, `graph`, `exports`, `choices`, `paths`.
   Tests: `test/workspace-manifest.test.ts`, `workspace-graph.test.ts`, `workspace-exports.test.ts`,
   `workspace-choices.test.ts`.
2. **Probes + waiter**: `probes.ts`, widen `WaitUntil`, `wait` RPC/CLI (`tcp:<port>`, `http:<url>`)/MCP.
   Tests: `test/probes.test.ts` (ephemeral 127.0.0.1:0 server, refused port, mid-poll start, abort);
   extend `test/waiter.test.ts`.
3. **Registry plumbing**: `RunOptions.env/workspace/ifRunning`, `own()`, eviction + `'forgotten'`,
   Flutter define derivation (export a `flutterConfigWith(config, env)` helper for unit testing).
   Tests: extend `test/registry-env.test.ts`; new `registry-duplicates.test.ts`, `registry-flutter-defines.test.ts`.
4. **Compose adapter** with scripted `spawnFn`. Test: `test/compose-adapter.test.ts` (fresh, external,
   `up` failure, ENOENT hint, `logs -f` dying).
5. **Engine + health** with fake host. Test: `test/workspace-engine.test.ts` (parallel within level,
   ordering, skip attribution, idempotent up, reverse down + `left`, switch restarts dependents only,
   cascade, remote reachable/unreachable, health flips, adopt, one run per manifest, dispose).
6. **Daemon wiring + e2e**: `#runTarget`, engine, RPC cases, `hello.workspaces`,
   `#describeProject.workspace` (deterministic, no timestamps), `close → dispose`.
   Test: `test/workspace-server.test.ts` modelled on `test/workflow-server.test.ts` (temp projects
   on `PORT=0`, `API_URL` export observed in console, second `up` no-op, switch to remote restarts
   console, down reports `left`, invalid manifest rejected before any session, push event over WS).
7. **Workflow bridge**: `convert.ts`, `workflowRun` over the engine, delete `runWorkflow`.
   Tests: `test/workflow-convert.test.ts`; adjust `test/workflow.test.ts`; `workflow-server.test.ts` unchanged.
8. **CLI, MCP, docs, example**. Tests: HELP/`parseUntil` contracts, MCP tool-name text contract,
   `test/workspace-example.test.ts` (example manifest targets resolve via `detectTargets`).
9. **HUD**: `workspace-pane.js`, `core.js` (`hello.workspaces`, `workspace` event, `hook('render')`,
   rail "Workspaces" from `project.workspace`, `fallbackPacks` learns `workspace.id`), `workspace.js`
   (`packSessions` prefers `workspace.id`, falls back to `workflow`; `nodeTone`, `orderedNodes`).
   Tests: extend `test/workspace.test.ts`, `test/hud.test.ts`.

## Gotchas to respect

- `erasableSyntaxOnly`: no enums, namespaces, or constructor parameter properties; `import type`;
  `.ts` import extensions.
- Every timer `unref()`; tests pass small `timeoutMs`/`healthIntervalMs` (suite timeout 20 s).
- Pre-flight in `up` is read-only (`detectTargets` + `matchTarget` + `validate`); `checkouts.resolve`
  creates worktrees, so it stays inside `#runTarget`.
- Two manifests naming the same target share a session id; adopting a session whose `workspace.id`
  differs should mark the node shared/read-only so one workspace's `down` doesn't silently stop the other's.
- `core.js` must not call `workspace*` RPCs itself (mirror the `editor.js` rule enforced in `test/hud.test.ts`).

## Verification

1. `npm run build && npm run typecheck && npm test` green.
2. `node src/cli/index.ts up examples/workflow-lab` → both nodes `ready`, console URL returned;
   open it and complete a delivery; `baton status` shows node · provider · status · url.
3. `baton stop api/delivery-api` then `baton up examples/workflow-lab` → only the API restarts (idempotent).
4. `baton down examples/workflow-lab` → both stopped; nothing else on the machine touched.
5. `baton workflow examples/workflow-lab/workflow.json` still returns the same result shape.
6. In the app: the workflow-lab root shows a workspace entry; node rows show status and provider;
   Up/Down and per-node stop work; MCP `start_workspace` via `baton-mcp` returns the structured run.
7. With Docker installed locally (manual, not CI): a manifest with a `compose` Postgres node comes
   up, shows `external` when the container was already running, and `down` leaves it alone.
