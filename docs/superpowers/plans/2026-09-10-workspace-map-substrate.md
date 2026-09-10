# Workspace Map Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a workspace describe not just what runs but what talks to what, with an evidence level per hop that no author can inflate — delivered as `baton map`.

**Architecture:** Three layers, bottom up. First the two engine defects that make the `wired` rung truthful for containers (dependency env never reached compose nodes; compose files cannot layer). Then the manifest grows a `documented` provider kind and a `flows` section. Then one pure function derives each hop's evidence from the live run, and one RPC serves it. The HUD view, the onboarding skill and the shape diff are separate follow-on plans that consume this substrate.

**Tech Stack:** TypeScript (node: imports, `.ts` extensions in imports), Zod 4 for schema, `node:test` + `node:assert/strict`, injection over mocks, no Docker in CI.

**Spec:** [../specs/2026-09-09-system-map-and-onboarding-design.md](../specs/2026-09-09-system-map-and-onboarding-design.md)

## Global Constraints

- Node >= 24. Imports use the `.ts` extension and `node:` prefixes, matching existing files.
- Tests: `node:test`, `assert/strict`, `npm test` runs `node --test "test/*.test.ts"`. No Docker, no simulator, no network in tests. Inject `spawnFn` / a fake `WorkspaceHost` instead.
- `tsc --noEmit` must pass. Hand-written `.d.ts` siblings are the convention for HUD assets only; this plan touches no HUD asset.
- Manifest limits already in `src/workspace/manifest.ts`: `MAX_NODES = 24`. This plan adds `MAX_FLOWS = 32`, `MAX_STEPS_PER_FLOW = 24`, `MAX_COMPOSE_FILES = 4`.
- Backward compatibility is required: a `baton.workspace.json` with no `flows` and a single-string `compose.file` must parse and behave exactly as it does today. `examples/workflow-lab/baton.workspace.json` must keep working untouched.
- Evidence values are exactly `'observed' | 'wired' | 'documented' | 'gated' | 'missing'`. `observed` is unreachable in this plan (no capture exists yet) and its input always reports zero.
- No author-facing field may set `wired` or `observed`. Schema must reject them.

---

### Task 1: Compose files that layer

Drive360's `compose.lab.yml` holds an override fragment for `bff` that is meaningless on its own; it only works as `-f compose.local.yml -f compose.lab.yml`. The manifest accepts one file today, so that stack is not expressible.

**Files:**
- Modify: `src/workspace/manifest.ts:18-21` (`composeRefSchema`), `:88` (path resolution)
- Modify: `src/adapters/compose.ts:5-13` (`ComposeSessionOptions`), `:62-69` (`forService`), `:168-172` (`#spawn`)
- Modify: `src/workspace/host.ts:17-27` (`ComposeRunRequest.file`)
- Modify: `src/daemon/workspace-host.ts:48-52` (pass-through)
- Modify: `src/workspace/engine.ts:230-236` (pass-through)
- Test: `test/compose-adapter.test.ts`, `test/workspace-manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ComposeRef.file` is **always `string[]`** after `parseManifest`, because the schema normalises a lone string into a one-element array. Every downstream consumer (`ComposeSessionOptions.file`, `ComposeRunRequest.file`) is `string[]`.

- [ ] **Step 1: Write the failing adapter test**

Add to `test/compose-adapter.test.ts`:

The file already has a `scripted()` spawn stand-in and a `settles(target, want)`
helper (defined around line 68). Use both — do not add new helpers.

```ts
test('several compose files are passed in order as repeated -f flags', async () => {
  const { spawnFn, argv } = scripted({ ps: { code: 0, stdout: '' }, up: { code: 0 } });
  const compose = ComposeSession.forService({
    file: ['/stack/compose.local.yml', '/stack/compose.lab.yml'],
    service: 'bff',
    spawnFn,
  });
  compose.start();
  await settles(compose, 'running');

  const up = argv.find((line) => line.includes('up'));
  assert.deepEqual(up, [
    'docker', 'compose',
    '-f', '/stack/compose.local.yml',
    '-f', '/stack/compose.lab.yml',
    'up', '-d', 'bff',
  ]);
});
```

Note the existing tests build their session through a local `session(spawnFn)`
helper that passes a single-file path. Leave that helper alone — Task 1 changes
`file` to a list, so update the helper's literal to `['/stack/compose.yml']`
(or whatever path it uses) and every existing test keeps passing unchanged.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "repeated -f"`
Expected: FAIL — the adapter emits `-f /stack/compose.local.yml,/stack/compose.lab.yml` (array stringified) or a type error.

- [ ] **Step 3: Make `ComposeSessionOptions.file` a list**

In `src/adapters/compose.ts`, change the option type and the two places that read it:

```ts
export type ComposeSessionOptions = {
  /** Absolute paths to the Compose files, in `-f` order, as resolved from the manifest. */
  file: string[];
  service: string;
  /** Folder whose basename prefixes the session id (the HUD project). */
  idRoot?: string;
  /** Injected in tests. */
  spawnFn?: typeof spawn;
};
```

In `forService`, the id and cwd derive from the first file:

```ts
  static forService(options: ComposeSessionOptions): ComposeSession {
    const name = `compose: ${options.service}`;
    return new ComposeSession(
      sessionId(options.idRoot ?? dirname(options.file[0]), options.service),
      name,
      options,
    );
  }
```

In `#spawn`, expand the list:

```ts
  #spawn(args: string[]): ChildProcess {
    const spawnFn = this.options.spawnFn ?? spawn;
    const files = this.options.file.flatMap((file) => ['-f', file]);
    // `shell: false` everywhere, including Windows: `docker` is a native
    // executable, and a shell would only make quoting depend on the arguments.
    return spawnFn('docker', ['compose', ...files, ...args], {
      cwd: dirname(this.options.file[0]),
      stdio: ['ignore', 'pipe', 'pipe'],
```

Leave the rest of `#spawn` (the options object's remaining keys) exactly as it is.

- [ ] **Step 4: Run the adapter test and watch it pass**

Run: `npm test 2>&1 | grep -A5 "repeated -f"`
Expected: PASS.

- [ ] **Step 5: Write the failing manifest test**

Add to `test/workspace-manifest.test.ts`:

```ts
test('a compose file may be one path or several, and both resolve to a list', () => {
  const one = parseManifest({
    name: 'One',
    nodes: { api: { providers: { local: { compose: { file: './compose.yml', service: 'api' } } } } },
  }, '/stack');
  assert.deepEqual(one.nodes.api.providers.local.compose!.file, ['/stack/compose.yml']);

  const many = parseManifest({
    name: 'Many',
    nodes: {
      bff: { providers: { lab: { compose: { file: ['./compose.local.yml', './compose.lab.yml'], service: 'bff' } } } },
    },
  }, '/stack');
  assert.deepEqual(many.nodes.bff.providers.lab.compose!.file, [
    '/stack/compose.local.yml',
    '/stack/compose.lab.yml',
  ]);
});

test('an empty compose file list is refused', () => {
  assert.throws(() => parseManifest({
    name: 'Empty',
    nodes: { bff: { providers: { lab: { compose: { file: [], service: 'bff' } } } } },
  }, '/stack'), /file/);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "one path or several"`
Expected: FAIL — a lone string stays a string.

- [ ] **Step 7: Normalise in the schema**

In `src/workspace/manifest.ts`, add the limit next to `MAX_NODES`:

```ts
const MAX_COMPOSE_FILES = 4;
```

Replace `composeRefSchema`:

```ts
const composeRefSchema = z.object({
  /**
   * One path, or several in `-f` order. Compose layers natively and real stacks
   * rely on it: an override fragment is meaningless without its base.
   * Normalised to a list so every consumer handles exactly one shape.
   */
  file: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1).max(MAX_COMPOSE_FILES),
  ]).transform((file) => (Array.isArray(file) ? file : [file])),
  service: z.string().min(1),
}).strict();
```

Replace the resolution line at `:88`:

```ts
      // A compose file is a path; a remote URL never is.
      if (provider.compose) {
        provider.compose.file = provider.compose.file.map((file) => resolve(baseDir, file));
      }
```

- [ ] **Step 8: Fix the two pass-throughs**

`src/workspace/host.ts`, in `ComposeRunRequest`:

```ts
export type ComposeRunRequest = {
  /** Compose files in `-f` order. */
  file: string[];
  service: string;
```

`src/workspace/engine.ts` and `src/daemon/workspace-host.ts` already forward `provider.compose.file` and `request.file` verbatim, so no change is needed there — confirm by reading both, and only edit if the compiler complains.

- [ ] **Step 9: Everything green**

Run: `npm run typecheck && npm test`
Expected: `tsc` clean; all tests pass (498 before this task, more now).

- [ ] **Step 10: Commit**

```bash
git add src/workspace/manifest.ts src/adapters/compose.ts src/workspace/host.ts test/compose-adapter.test.ts test/workspace-manifest.test.ts
git commit -m "feat(compose): a node may layer several compose files"
```

---

### Task 2: Dependency env reaches compose nodes

`src/workspace/engine.ts:226` computes `dependencyEnv(...)` and passes it **only** to `runTarget` at `:248`. The compose branch at `:229-239` discards it. Consequence: `baton switch retail-order cloud` stops the container, marks the node external and restarts the BFF — but the BFF's compose file hardcodes `RETAIL_ORDER_SERVICE_URL`, so it still talks to the service that just went away. The workspace's headline capability silently does not work for containers, which is nearly all of Drive360.

**Files:**
- Modify: `src/adapters/compose.ts` (`ComposeSessionOptions`, `#spawn`)
- Modify: `src/workspace/host.ts` (`ComposeRunRequest`)
- Modify: `src/daemon/workspace-host.ts:48-52` (`runCompose`)
- Modify: `src/workspace/engine.ts:229-239` (compose branch)
- Test: `test/compose-adapter.test.ts`, `test/workspace-engine.test.ts`

**Interfaces:**
- Consumes: `ComposeSessionOptions.file: string[]` from Task 1.
- Produces: `ComposeRunRequest.env: Record<string, string>` (required, may be empty) and `ComposeSessionOptions.env?: Record<string, string>`. A fake `WorkspaceHost` in tests can now assert on `runCompose(request).env`.

- [ ] **Step 1: Write the failing adapter test**

Add to `test/compose-adapter.test.ts`:

`scripted` records only `argv` today. Extend it to also capture the third
`spawn` argument: add `const opts: Record<string, unknown>[] = []` beside
`argv`, push the third parameter inside the `spawnFn` body in the same order,
and return `opts` alongside `argv`.

```ts
test('dependency env is handed to the docker compose process for interpolation', async () => {
  const { spawnFn, argv, opts } = scripted({ ps: { code: 0, stdout: '' }, up: { code: 0 } });
  const compose = ComposeSession.forService({
    file: ['/stack/compose.yml'],
    service: 'bff',
    env: { RETAIL_ORDER_SERVICE_URL: 'http://127.0.0.1:8082' },
    spawnFn,
  });
  compose.start();
  await settles(compose, 'running');

  const index = argv.findIndex((line) => line.includes('up'));
  const env = opts[index]?.env as Record<string, string> | undefined;
  assert.equal(env?.RETAIL_ORDER_SERVICE_URL, 'http://127.0.0.1:8082');
  // The ambient environment must survive, or docker loses PATH and cannot run.
  assert.ok(env?.PATH, 'PATH is still present');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "handed to the docker compose process"`
Expected: FAIL — `env` is not an accepted option, or `up.env` is undefined.

- [ ] **Step 3: Accept and forward env**

In `src/adapters/compose.ts`, add to `ComposeSessionOptions`:

```ts
  /**
   * Env for the `docker compose` process itself, so the file's own `${VAR}`
   * interpolation resolves against what the workspace injected. Compose has no
   * per-service override flag; interpolation is the supported seam.
   */
  env?: Record<string, string>;
```

In `#spawn`, merge it over the ambient environment:

```ts
    return spawnFn('docker', ['compose', ...files, ...args], {
      cwd: dirname(this.options.file[0]),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
```

Keep any other keys already present in that options object unchanged.

- [ ] **Step 4: Run the adapter test and watch it pass**

Run: `npm test 2>&1 | grep -A5 "handed to the docker compose process"`
Expected: PASS.

- [ ] **Step 5: Write the failing engine regression test**

This is the test whose absence let the defect ship.

First make the file's existing `fakeHost` record the env it was handed, exactly as
`runTarget` already does. One line, at `test/workspace-engine.test.ts:46`:

```ts
      calls.push(`runCompose:${request.workspace.node}:${JSON.stringify(request.env)}`);
```

No existing assertion reads that string, so nothing else changes. Then add the test,
using the file's `fakeHost()`, `loaded()` and `target()` helpers:

```ts
test('switching a dependency rewires a compose dependent, not just a target one', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const work = loaded({
    api: {
      exports: { API_URL: '${url}' },
      providers: {
        local: target('api'),
        cloud: { remote: { url: 'https://api-dev.example.com' } },
      },
    },
    web: {
      dependsOn: ['api'],
      providers: { local: { compose: { file: './compose.yml', service: 'web' } } },
    },
  }, { api: 'local', web: 'local' });

  await engine.up(work);
  assert.ok(
    fake.calls.includes('runCompose:web:{"API_URL":"http://127.0.0.1/api"}'),
    `compose started with the local upstream: ${fake.calls.join(', ')}`,
  );

  await engine.switch(work.manifestPath, 'api', 'cloud');
  assert.ok(
    fake.calls.includes('runCompose:web:{"API_URL":"https://api-dev.example.com"}'),
    `compose was restarted with the cloud upstream: ${fake.calls.join(', ')}`,
  );
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A8 "rewires a compose dependent"`
Expected: FAIL — `composeEnv.at(-1)` is `undefined` (env is not passed) or `API_URL` is missing.

- [ ] **Step 7: Thread env through the seam**

`src/workspace/host.ts`, in `ComposeRunRequest`:

```ts
  /** Exports of this node's direct dependencies, for Compose interpolation. */
  env: Record<string, string>;
```

`src/daemon/workspace-host.ts`, in `runCompose`:

```ts
    async runCompose(request) {
      const session = ComposeSession.forService({
        file: request.file,
        service: request.service,
        idRoot: request.root,
        env: request.env,
      });
```

`src/workspace/engine.ts`, in the compose branch of `#start`:

```ts
    if (provider.compose) {
      const started = await this.#host.runCompose({
        file: provider.compose.file,
        service: provider.compose.service,
        root: live.run.root,
        env,
        workspace,
        workflow: live.run.name,
        timeoutMs: provider.timeoutMs,
      });
```

The `env` binding already exists two lines above; this is the line that was missing.

- [ ] **Step 8: Run the engine test and watch it pass**

Run: `npm test 2>&1 | grep -A8 "rewires a compose dependent"`
Expected: PASS.

- [ ] **Step 9: Everything green**

Run: `npm run typecheck && npm test`
Expected: `tsc` clean; all tests pass.

- [ ] **Step 10: Document the consumer-side requirement**

Append to `docs/launch-guide.md`, in the workspace section (find the heading that documents `compose` providers and add immediately after it):

```markdown
Baton passes a node's inherited exports to the `docker compose` process as
environment, so a Compose file picks them up through its own interpolation.
Write the file so the default still stands alone:

```yaml
environment:
  RETAIL_ORDER_SERVICE_URL: ${RETAIL_ORDER_SERVICE_URL:-http://retail-order:8080}
```

A hardcoded value cannot be rewired, so `baton switch` on the upstream node
would restart this service and change nothing.
```

- [ ] **Step 11: Commit**

```bash
git add src/adapters/compose.ts src/workspace/host.ts src/daemon/workspace-host.ts src/workspace/engine.ts test/compose-adapter.test.ts test/workspace-engine.test.ts docs/launch-guide.md
git commit -m "fix(workspace): dependency env reaches compose nodes, so switch rewires them"
```

---

### Task 3: Nodes that are real and unrunnable

IBM MQ, DB2, Apigee, PeopleNet and OnBase are genuine parts of Drive360's flows and can never run on a laptop. Dropping them would make every path appear to stop early. A fourth provider kind declares them: drawn always, started never, probed never.

**Files:**
- Modify: `src/workspace/manifest.ts:33-44` (`providerSchema`)
- Modify: `src/workspace/types.ts:19-28` (`NodeStatus`)
- Modify: `src/workspace/engine.ts` (`#start`, `down`, `#watch`)
- Test: `test/workspace-manifest.test.ts`, `test/workspace-engine.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NodeStatus` gains the literal `'documented'`. `WorkspaceProvider` gains optional `documented?: { note?: string }`. Exactly one of `target | compose | remote | documented` is required.

- [ ] **Step 1: Write the failing manifest test**

```ts
test('a node may declare a provider that is never started', () => {
  const manifest = parseManifest({
    name: 'Mainframe',
    nodes: {
      'ibm-mq': {
        kind: 'queue',
        providers: { mainframe: { documented: { note: 'Reached only through the ported client.' } } },
      },
    },
  }, '/stack');
  assert.equal(manifest.nodes['ibm-mq'].providers.mainframe.documented?.note,
    'Reached only through the ported client.');
});

test('a provider still declares exactly one kind', () => {
  assert.throws(() => parseManifest({
    name: 'Both',
    nodes: {
      db2: { providers: { x: { documented: {}, remote: { url: 'https://example.com' } } } },
    },
  }, '/stack'), /exactly one of/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "never started"`
Expected: FAIL — `documented` is an unrecognised key (schema is `.strict()`).

- [ ] **Step 3: Add the provider kind**

In `src/workspace/manifest.ts`, above `providerSchema`:

```ts
/** A part of the system Baton will never start: a mainframe, a queue manager, a gateway. */
const documentedRefSchema = z.object({ note: z.string().min(1).optional() }).strict();
```

Add the field and widen the refine:

```ts
const providerSchema = z.object({
  target: targetRefSchema.optional(),
  compose: composeRefSchema.optional(),
  remote: remoteRefSchema.optional(),
  documented: documentedRefSchema.optional(),
  /** An explicit URL, when readiness alone cannot tell Baton where the node lives. */
  url: z.string().min(1).optional(),
  ready: readySchema.optional(),
  timeoutMs: z.number().int().min(1).max(300000).default(60000),
}).strict().refine(
  (p) => [p.target, p.compose, p.remote, p.documented].filter(Boolean).length === 1,
  'a provider must declare exactly one of target, compose, remote or documented',
);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test 2>&1 | grep -A5 "never started"`
Expected: PASS, both tests.

- [ ] **Step 5: Write the failing engine test**

```ts
test('a documented node is never started, never probed and never stopped', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const work = loaded({
    db2: { kind: 'datastore', providers: { mainframe: { documented: { note: 'z/OS' } } } },
  });
  const run = await engine.up(work);

  assert.equal(run.nodes.db2.status, 'documented');
  assert.equal(run.nodes.db2.readOnly, true);
  assert.equal(run.nodes.db2.sessionId, undefined);
  assert.deepEqual(fake.calls, [], 'nothing was spawned, waited on, or probed');

  const down = await engine.down(work.manifestPath);
  assert.deepEqual(down.stopped, []);
  assert.deepEqual(down.left, [], 'a node that never ran is not "left running"');
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A8 "never started, never probed"`
Expected: FAIL — status is `failed` or the engine throws on a provider with no target.

- [ ] **Step 7: Add the status and the three engine branches**

`src/workspace/types.ts`, extend the union and document it:

```ts
/**
 * Where a node is in its lifecycle.
 *
 * `external` is the honest answer for something Baton found already running (a
 * remote endpoint, a container someone else started): it is usable, but Baton
 * did not start it and will not stop it.
 *
 * `documented` is the honest answer for something Baton will never start at
 * all — a mainframe, a queue manager. It is on the map because the flows cross
 * it, not because it can be run.
 */
export type NodeStatus =
  | 'pending'
  | 'starting'
  | 'ready'
  | 'unhealthy'
  | 'failed'
  | 'skipped'
  | 'stopped'
  | 'external'
  | 'documented';
```

`src/workspace/engine.ts`, in `#start`, **before** the remote branch:

```ts
    if (provider.documented) {
      this.#set(live, node, {
        status: 'documented',
        url: provider.url,
        readOnly: true,
        sessionId: undefined,
        error: undefined,
      });
      return;
    }
```

In `down`, skip documented nodes before the `readOnly` check that would otherwise report them as left running:

```ts
      // Never started, so neither stopped nor "left running".
      if (state.status === 'documented') continue;
```

In `#bring`, add `'documented'` to the set of statuses treated as already settled, alongside `ready` / `external` / `unhealthy`, so a second `up` is idempotent. Read the exact condition at `engine.ts:188` and extend it in place.

- [ ] **Step 8: Run the engine test and watch it pass**

Run: `npm test 2>&1 | grep -A8 "never started, never probed"`
Expected: PASS.

- [ ] **Step 9: Everything green**

Run: `npm run typecheck && npm test`
Expected: `tsc` clean; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/workspace/manifest.ts src/workspace/types.ts src/workspace/engine.ts test/workspace-manifest.test.ts test/workspace-engine.test.ts
git commit -m "feat(workspace): a documented provider for parts a laptop cannot run"
```

---

### Task 4: Flows in the manifest

The unit of the map is a named flow — an ordered path — not a bag of edges. Drive360's own docs already number nine of them.

**Files:**
- Modify: `src/workspace/manifest.ts` (`flowStepSchema`, `flowSchema`, `manifestSchema`)
- Modify: `src/workspace/graph.ts` (`validateFlows`, called from `validateGraph`)
- Test: `test/workspace-manifest.test.ts`, `test/workspace-graph.test.ts` (create if absent — check first)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type FlowStep = z.infer<typeof flowStepSchema>;
  // { from, to, what, protocol?, queued, cite?, missing, note?, flag? }
  export type Flow = z.infer<typeof flowSchema>;
  // { id, name, source?, steps: FlowStep[] }
  ```
  `WorkspaceManifest` gains `flows: Flow[]`, defaulting to `[]`.

- [ ] **Step 1: Write the failing schema tests**

```ts
test('a flow is an ordered list of cited hops', () => {
  const manifest = parseManifest({
    name: 'Delivery',
    nodes: {
      app: { providers: { local: { documented: {} } } },
      api: { providers: { local: { documented: {} } } },
    },
    flows: [{
      id: 'capture',
      name: 'Capture',
      source: 'docs/01-architecture.md §6.4',
      steps: [{ from: 'app', to: 'api', what: 'stop capture upload', protocol: 'http', cite: 'lib/api/client.dart:408' }],
    }],
  }, '/stack');
  assert.equal(manifest.flows[0].steps[0].what, 'stop capture upload');
  assert.equal(manifest.flows[0].steps[0].queued, false);
  assert.equal(manifest.flows[0].steps[0].missing, false);
});

test('a hop needs a citation unless it is explicitly missing', () => {
  const base = { name: 'X', nodes: { a: { providers: { p: { documented: {} } } }, b: { providers: { p: { documented: {} } } } } };
  assert.throws(() => parseManifest({
    ...base,
    flows: [{ id: 'f', name: 'F', steps: [{ from: 'a', to: 'b', what: 'unproven' }] }],
  }, '/s'), /cite/);

  const missing = parseManifest({
    ...base,
    flows: [{ id: 'f', name: 'F', steps: [{ from: 'a', to: 'b', what: 'unbuilt leg', missing: true, note: 'No consumer exists.' }] }],
  }, '/s');
  assert.equal(missing.flows[0].steps[0].missing, true);
});

test('evidence cannot be authored', () => {
  assert.throws(() => parseManifest({
    name: 'X',
    nodes: { a: { providers: { p: { documented: {} } } }, b: { providers: { p: { documented: {} } } } },
    flows: [{ id: 'f', name: 'F', steps: [{ from: 'a', to: 'b', what: 'x', cite: 'a.ts:1', evidence: 'observed' }] }],
  }, '/s'), /evidence|Unrecognized/);
});

test('a manifest with no flows is still a manifest', () => {
  const manifest = parseManifest({
    name: 'X', nodes: { a: { providers: { p: { documented: {} } } } },
  }, '/s');
  assert.deepEqual(manifest.flows, []);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test 2>&1 | grep -A5 "ordered list of cited hops"`
Expected: FAIL — `flows` is an unrecognised key.

- [ ] **Step 3: Add the schema**

In `src/workspace/manifest.ts`, add the limits beside `MAX_NODES`:

```ts
const MAX_FLOWS = 32;
const MAX_STEPS_PER_FLOW = 24;
```

Add above `manifestSchema`:

```ts
/**
 * One hop in a flow.
 *
 * There is deliberately no `evidence` field: how strongly a hop is believed is
 * derived at read time from the live run, never authored. An author can supply
 * a citation, a flag, or an admission that nothing is built — and nothing else.
 */
const flowStepSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** One phrase, because this is the label a reader sees on the edge. */
  what: z.string().min(1).max(120),
  protocol: z.string().min(1).max(24).optional(),
  /** True when the hop drains from a local queue and is never synchronous. */
  queued: z.boolean().default(false),
  /** `path:line`, repo-relative. The reader must be able to check the claim. */
  cite: z.string().min(1).optional(),
  /** The architecture requires this hop and no implementation was found. */
  missing: z.boolean().default(false),
  note: z.string().min(1).optional(),
  /** A flag whose `default: false` is what makes the hop read as gated. */
  flag: z.object({
    name: z.string().min(1),
    default: z.boolean(),
    note: z.string().min(1).optional(),
  }).strict().optional(),
}).strict()
  .refine((s) => s.missing || Boolean(s.cite), 'a hop needs a cite unless it is missing')
  .refine((s) => !s.missing || Boolean(s.note), 'a missing hop needs a note saying what is absent')
  .refine((s) => !(s.missing && s.cite), 'a missing hop cannot also cite an implementation');

const flowSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  /** Where this flow is described in prose, so the map and the doc stay tied. */
  source: z.string().min(1).optional(),
  steps: z.array(flowStepSchema).min(1).max(MAX_STEPS_PER_FLOW),
}).strict();

export type FlowStep = z.infer<typeof flowStepSchema>;
export type Flow = z.infer<typeof flowSchema>;
```

Extend `manifestSchema`:

```ts
export const manifestSchema = z.object({
  name: z.string().min(1).max(100),
  nodes: z.record(z.string().min(1), nodeSchema),
  /** The team's default provider per node, committed alongside the manifest. */
  defaults: z.record(z.string().min(1), z.string().min(1)).default({}),
  /** Named end-to-end paths through the graph. Absent is fine; the map is then node-only. */
  flows: z.array(flowSchema).max(MAX_FLOWS).default([]),
}).strict();
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm test 2>&1 | grep -A5 "ordered list of cited hops"`
Expected: PASS, all four tests.

- [ ] **Step 5: Write the failing graph test**

Flows reference nodes, so unknown references must fail with the graph, not at render time. Add to `test/workspace-graph.test.ts` (create the file with the same imports the other workspace tests use if it does not exist):

Build the manifests through `parseManifest` rather than casting a literal — the
schema fills in defaults the validator relies on, and it keeps the test honest
about what a real manifest looks like.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/workspace/manifest.ts';
import { validateGraph } from '../src/workspace/graph.ts';

const paper = { providers: { p: { documented: {} } } };

test('a flow may not name a node that does not exist', () => {
  const manifest = parseManifest({
    name: 'X',
    nodes: { a: paper, b: paper },
    flows: [{ id: 'f', name: 'F', steps: [{ from: 'a', to: 'ghost', what: 'x', cite: 'a.ts:1' }] }],
  }, '/s');
  assert.throws(() => validateGraph(manifest), /ghost/);
});

test('two flows may not share an id', () => {
  const manifest = parseManifest({
    name: 'X',
    nodes: { a: paper, b: paper },
    flows: [
      { id: 'dup', name: 'One', steps: [{ from: 'a', to: 'b', what: 'x', cite: 'a.ts:1' }] },
      { id: 'dup', name: 'Two', steps: [{ from: 'b', to: 'a', what: 'y', cite: 'b.ts:1' }] },
    ],
  }, '/s');
  assert.throws(() => validateGraph(manifest), /dup/);
});

test('a hop from a node to itself is refused', () => {
  const manifest = parseManifest({
    name: 'X',
    nodes: { a: paper },
    flows: [{ id: 'f', name: 'F', steps: [{ from: 'a', to: 'a', what: 'x', cite: 'a.ts:1' }] }],
  }, '/s');
  assert.throws(() => validateGraph(manifest), /itself/);
});

test('a flow may run against the dependency direction', () => {
  // Bring-up order and data flow are different questions: the write-back
  // service depends on the database to start, but data flows database -> relay.
  const manifest = parseManifest({
    name: 'X',
    nodes: { db: paper, relay: { dependsOn: ['db'], ...paper } },
    flows: [{
      id: 'drain', name: 'Drain',
      steps: [{ from: 'db', to: 'relay', what: 'poll the outbox', cite: 'Relay.java:51' }],
    }],
  }, '/s');
  validateGraph(manifest);
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npm test 2>&1 | grep -A5 "may not name a node"`
Expected: FAIL — `validateGraph` ignores `flows` entirely, so nothing throws.

- [ ] **Step 7: Validate flows with the graph**

In `src/workspace/graph.ts`, add at the end of `validateGraph`'s body:

```ts
  validateFlows(manifest);
```

And add the function below it:

```ts
/**
 * Flows are checked with the graph because they name nodes.
 *
 * A flow deliberately does *not* have to follow `dependsOn`: bring-up order and
 * data flow are different questions. The write-back service depends on Cloud
 * SQL to start, while the data flows from Cloud SQL into the relay.
 */
export function validateFlows(manifest: WorkspaceManifest): void {
  const names = new Set(Object.keys(manifest.nodes));
  const ids = new Set<string>();
  for (const flow of manifest.flows) {
    if (ids.has(flow.id)) throw new Error(`two flows share the id "${flow.id}"`);
    ids.add(flow.id);
    for (const step of flow.steps) {
      for (const end of [step.from, step.to]) {
        if (!names.has(end)) {
          throw new Error(`flow "${flow.id}" names "${end}", which is not a node in this workspace`);
        }
      }
      if (step.from === step.to) {
        throw new Error(`flow "${flow.id}" has a hop from "${step.from}" to itself`);
      }
    }
  }
}
```

- [ ] **Step 8: Run them and watch them pass**

Run: `npm test 2>&1 | grep -A5 "may not name a node"`
Expected: PASS, all three tests.

- [ ] **Step 9: Everything green, and the example still parses**

Run: `npm run typecheck && npm test`
Expected: `tsc` clean; all tests pass, including `test/workspace-example.test.ts`, which parses `examples/workflow-lab/baton.workspace.json` — a manifest with no `flows`.

- [ ] **Step 10: Commit**

```bash
git add src/workspace/manifest.ts src/workspace/graph.ts test/workspace-manifest.test.ts test/workspace-graph.test.ts
git commit -m "feat(workspace): flows — named paths through the graph, every hop cited"
```

---

### Task 5: Deriving evidence

The load-bearing rule of the whole design: an author can only ever produce `documented`, `gated` or `missing`. `wired` comes from Baton's own bookkeeping; `observed` from the runtime. One pure function, so it is testable without Docker.

**Files:**
- Create: `src/workspace/evidence.ts`
- Modify: `src/workspace/types.ts` (add the `Evidence` union)
- Create: `test/workspace-evidence.test.ts`

**Interfaces:**
- Consumes: `FlowStep` from Task 4; `NodeStatus` from Task 3.
- Produces: `Evidence` lives in `src/workspace/types.ts`, not in `evidence.ts`. `types.ts` is "the live view every surface renders", and putting the union there keeps the dependency one-way: `evidence.ts` imports from `types.ts` and never the reverse. Defining it in `evidence.ts` while `types.ts` needs it for `MappedStep` (Task 6) would make the two files import each other.
  ```ts
  // in types.ts
  export type Evidence = 'observed' | 'wired' | 'documented' | 'gated' | 'missing';
  // in evidence.ts
  export type EvidenceContext = {
    status(node: string): NodeStatus | undefined;
    urlOf(node: string): string | undefined;
    injectedInto(node: string): Record<string, string>;
    flagValue(name: string): boolean | undefined;
    observedCount(step: FlowStep): number;
  };
  export function evidenceFor(step: FlowStep, ctx: EvidenceContext): Evidence;
  export function isUp(status: NodeStatus | undefined): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/workspace-evidence.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFor, type EvidenceContext } from '../src/workspace/evidence.ts';
import type { FlowStep } from '../src/workspace/manifest.ts';


const step = (over: Partial<FlowStep> = {}): FlowStep => ({
  from: 'app', to: 'api', what: 'upload', queued: false, missing: false, cite: 'a.ts:1', ...over,
} as FlowStep);

const ctx = (over: Partial<EvidenceContext> = {}): EvidenceContext => ({
  status: () => 'ready',
  urlOf: (n) => (n === 'api' ? 'http://127.0.0.1:8082' : undefined),
  injectedInto: () => ({}),
  flagValue: () => undefined,
  observedCount: () => 0,
  ...over,
});

test('a hop with only a citation is on paper', () => {
  assert.equal(evidenceFor(step(), ctx()), 'documented');
});

test('a hop Baton wired is wired', () => {
  const c = ctx({ injectedInto: (n) => (n === 'app' ? { API_URL: 'http://127.0.0.1:8082' } : {}) });
  assert.equal(evidenceFor(step(), c), 'wired');
});

test('a pull hop is wired from the consuming end', () => {
  // The relay polls the database: the URL lives on `to`, not `from`.
  const c = ctx({
    urlOf: (n) => (n === 'db' ? 'postgres://127.0.0.1:55432' : undefined),
    injectedInto: (n) => (n === 'relay' ? { SPRING_DATASOURCE_URL: 'postgres://127.0.0.1:55432' } : {}),
  });
  assert.equal(evidenceFor(step({ from: 'db', to: 'relay' }), c), 'wired');
});

test('a hop is not wired while either end is down', () => {
  const c = ctx({
    status: (n) => (n === 'api' ? 'stopped' : 'ready'),
    injectedInto: (n) => (n === 'app' ? { API_URL: 'http://127.0.0.1:8082' } : {}),
  });
  assert.equal(evidenceFor(step(), c), 'documented');
});

test('observed beats wired', () => {
  const c = ctx({
    injectedInto: (n) => (n === 'app' ? { API_URL: 'http://127.0.0.1:8082' } : {}),
    observedCount: () => 12,
  });
  assert.equal(evidenceFor(step(), c), 'observed');
});

test('a flag that is off beats observation', () => {
  // A flag being off is a fact about the environment; two healthy ends do not change it.
  const c = ctx({
    flagValue: () => false,
    injectedInto: (n) => (n === 'app' ? { API_URL: 'http://127.0.0.1:8082' } : {}),
    observedCount: () => 12,
  });
  assert.equal(evidenceFor(step({ flag: { name: 'MQ_ENABLED', default: false } }), c), 'gated');
});

test('a flag that is on does not gate', () => {
  const c = ctx({ flagValue: () => true });
  assert.equal(evidenceFor(step({ flag: { name: 'MQ_ENABLED', default: false } }), c), 'documented');
});

test('an unresolvable flag falls back to its declared default', () => {
  const c = ctx({ flagValue: () => undefined });
  assert.equal(evidenceFor(step({ flag: { name: 'MQ_ENABLED', default: false } }), c), 'gated');
  assert.equal(evidenceFor(step({ flag: { name: 'IMG_ENABLED', default: true } }), c), 'documented');
});

test('missing beats everything', () => {
  const c = ctx({
    flagValue: () => false,
    injectedInto: (n) => (n === 'app' ? { API_URL: 'http://127.0.0.1:8082' } : {}),
    observedCount: () => 12,
  });
  assert.equal(
    evidenceFor(step({ missing: true, cite: undefined, note: 'no consumer exists' }), c),
    'missing',
  );
});

test('a documented node counts as up, so a mainframe hop can still be wired', () => {
  const c = ctx({
    status: (n) => (n === 'mq' ? 'documented' : 'ready'),
    urlOf: (n) => (n === 'mq' ? 'mq://queue-manager' : undefined),
    injectedInto: (n) => (n === 'relay' ? { MQ_URL: 'mq://queue-manager' } : {}),
  });
  assert.equal(evidenceFor(step({ from: 'relay', to: 'mq' }), c), 'wired');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test 2>&1 | grep -A5 "only a citation is on paper"`
Expected: FAIL — `src/workspace/evidence.ts` does not exist.

- [ ] **Step 3: Write the function**

First add the union to `src/workspace/types.ts`:

```ts
/**
 * How strongly one hop is believed, weakest to strongest — plus the two states
 * that override belief entirely.
 *
 * The asymmetry here is the point of the whole design. An agent writing a
 * manifest can only ever produce `documented`, `gated` or `missing`: the first
 * rests on a citation, and the other two are admissions. `wired` is computed
 * from what Baton itself injected, and `observed` from what the runtime saw.
 * Neither is expressible in the file, so a confident-sounding agent cannot
 * manufacture a reader's confidence.
 */
export type Evidence = 'observed' | 'wired' | 'documented' | 'gated' | 'missing';
```

Then create `src/workspace/evidence.ts`:

```ts
import type { FlowStep } from './manifest.ts';
import type { Evidence, NodeStatus } from './types.ts';

export type EvidenceContext = {
  status(node: string): NodeStatus | undefined;
  urlOf(node: string): string | undefined;
  /** What Baton set on this node, from `dependencyEnv`. */
  injectedInto(node: string): Record<string, string>;
  /** The effective value, or undefined when Baton cannot resolve it. */
  flagValue(name: string): boolean | undefined;
  /** Captured traffic across this hop. Always 0 until capture exists. */
  observedCount(step: FlowStep): number;
};

/** Usable right now, by any means: running, someone else's, or on paper. */
export function isUp(status: NodeStatus | undefined): boolean {
  return status === 'ready' || status === 'external' || status === 'documented';
}

/**
 * A hop is wired when Baton set a variable on one of its ends whose value is
 * the other end's address.
 *
 * The match is direction-agnostic on purpose. For a push hop the caller holds
 * the callee's URL; for a pull hop it is the other way round — a relay that
 * polls an outbox consumes the *database's* URL, so the consumer is the `to`
 * end. Requiring the caller to hold the address would silently mark every
 * polling hop unwired.
 */
function wiredBetween(step: FlowStep, ctx: EvidenceContext): boolean {
  const pairs: [string, string][] = [[step.from, step.to], [step.to, step.from]];
  for (const [holder, other] of pairs) {
    const address = ctx.urlOf(other);
    if (!address) continue;
    if (Object.values(ctx.injectedInto(holder)).includes(address)) return true;
  }
  return false;
}

/** First match wins; the order is the whole contract. */
export function evidenceFor(step: FlowStep, ctx: EvidenceContext): Evidence {
  // A hop that does not exist cannot be observed, however healthy its ends are.
  if (step.missing) return 'missing';

  // A flag being off is a fact about this environment. It outranks observation
  // so the map can answer "why is no data reaching the mainframe?".
  if (step.flag) {
    const value = ctx.flagValue(step.flag.name) ?? step.flag.default;
    if (!value) return 'gated';
  }

  const ends = isUp(ctx.status(step.from)) && isUp(ctx.status(step.to));
  if (ends && ctx.observedCount(step) > 0) return 'observed';
  if (ends && wiredBetween(step, ctx)) return 'wired';
  return 'documented';
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm test 2>&1 | grep -A5 "only a citation is on paper"`
Expected: PASS, all ten tests.

- [ ] **Step 5: Everything green**

Run: `npm run typecheck && npm test`
Expected: `tsc` clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/evidence.ts src/workspace/types.ts test/workspace-evidence.test.ts
git commit -m "feat(workspace): derive a hop's evidence, so no author can inflate it"
```

---

### Task 6: `workspaceMap` and `baton map`

The substrate becomes usable: one RPC that reads the manifest from disk — so it answers with the workspace **down**, which is when a newcomer's first question arrives — and one command that prints it.

**Files:**
- Modify: `src/workspace/types.ts` (map result types)
- Modify: `src/workspace/engine.ts` (`map` method)
- Modify: `src/core/api.ts:353` area (add `workspaceMap` to the RPC map)
- Modify: `src/daemon/server.ts:753-785` area (handler)
- Modify: `src/cli/index.ts` (`map` case, printer)
- Test: `test/workspace-server.test.ts`, `test/cli-workspace.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowStep` (Task 4), `Evidence`, `evidenceFor`, `isUp` (Task 5), `NodeStatus` (Task 3).
- Produces:
  ```ts
  export type MappedStep = FlowStep & { evidence: Evidence };
  export type MappedFlow = { id: string; name: string; source?: string; steps: MappedStep[] };
  export type MappedNode = {
    kind: NodeKind; providers: string[]; provider?: string;
    status?: NodeStatus; url?: string; runnable: boolean;
  };
  export type WorkspaceMap = {
    name: string; manifestPath: string; root: string; up: boolean;
    nodes: Record<string, MappedNode>;
    flows: MappedFlow[];
    tally: Record<Evidence, number>;
  };
  ```
  RPC: `workspaceMap: { params: { manifest?: string; cwd?: string }; result: WorkspaceMap }`.

- [ ] **Step 1: Write the failing server test**

Add to `test/workspace-server.test.ts`, following the existing daemon-harness pattern in that file (read it first and reuse its setup verbatim):

```ts
test('workspaceMap answers from the manifest with the workspace down', async () => {
  const root = await writeWorkspace({
    name: 'Paper stack',
    nodes: {
      app: { kind: 'mobile', providers: { local: { documented: {} } } },
      api: { kind: 'backend', providers: { local: { documented: {} } } },
      mq: { kind: 'queue', providers: { mainframe: { documented: { note: 'z/OS' } } } },
    },
    flows: [{
      id: 'settle',
      name: 'Settle',
      steps: [
        { from: 'app', to: 'api', what: 'stop upload', cite: 'app/client.dart:408' },
        { from: 'api', to: 'mq', what: 'seven queues', cite: 'api/Queue.java:73',
          flag: { name: 'MQ_ENABLED', default: false } },
        { from: 'mq', to: 'api', what: 'unbuilt ack', missing: true, note: 'No consumer exists.' },
      ],
    }],
  });

  const map = await client.call('workspaceMap', { cwd: root });

  assert.equal(map.up, false);
  assert.equal(map.name, 'Paper stack');
  assert.equal(map.nodes.mq.runnable, false);
  assert.deepEqual(map.flows[0].steps.map((s: { evidence: string }) => s.evidence),
    ['documented', 'gated', 'missing']);
  assert.equal(map.tally.documented, 1);
  assert.equal(map.tally.gated, 1);
  assert.equal(map.tally.missing, 1);
  assert.equal(map.tally.wired, 0);
  assert.equal(map.tally.observed, 0);
});
```

`writeWorkspace` is a helper you add to that test file if it lacks one: write the JSON to a temp dir under `BATON_HOME` and return the directory.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A8 "answers from the manifest"`
Expected: FAIL — unknown method `workspaceMap`.

- [ ] **Step 3: Add the result types**

Append to `src/workspace/types.ts`. `Evidence` is already declared in this file
from Task 5, so only the manifest types need importing:

```ts
import type { Flow, FlowStep } from './manifest.ts';

/** A hop with its evidence resolved. `evidence` is derived, never authored. */
export type MappedStep = FlowStep & { evidence: Evidence };
export type MappedFlow = Omit<Flow, 'steps'> & { steps: MappedStep[] };

export type MappedNode = {
  kind: NodeKind;
  /** Every provider this node offers. */
  providers: string[];
  /** The chosen provider, when the workspace is up. */
  provider?: string;
  status?: NodeStatus;
  url?: string;
  /** False for a `documented` provider: real, and never startable here. */
  runnable: boolean;
};

/**
 * The whole map, readable with the workspace down.
 *
 * Reading from disk rather than from a live run is deliberate: a newcomer's
 * first question arrives before they can start anything.
 */
export type WorkspaceMap = {
  name: string;
  manifestPath: string;
  root: string;
  /** True when a run exists, which is what lets any hop reach `wired`. */
  up: boolean;
  nodes: Record<string, MappedNode>;
  flows: MappedFlow[];
  tally: Record<Evidence, number>;
};
```

- [ ] **Step 4: Add `map` to the engine**

In `src/workspace/engine.ts`, add a public method. It takes a `LoadedManifest` and finds the run itself, so a caller never has to know whether one exists:

```ts
  /**
   * The map for a manifest, live run or not.
   *
   * Evidence is resolved here rather than by the caller because only the engine
   * knows what it injected into each node — which is exactly what makes `wired`
   * a fact rather than a claim.
   */
  map(loaded: LoadedManifest): WorkspaceMap {
    const { manifest, manifestPath, root } = loaded;
    const live = this.#find(manifestPath);
    const urls = live ? this.#urls(live) : {};

    const injected: Record<string, Record<string, string>> = {};
    for (const node of Object.keys(manifest.nodes)) {
      injected[node] = live ? dependencyEnv(manifest, node, urls) : {};
    }

    const ctx: EvidenceContext = {
      status: (node) => live?.run.nodes[node]?.status,
      urlOf: (node) => live?.run.nodes[node]?.url,
      injectedInto: (node) => injected[node] ?? {},
      // Flags live in the environment Baton injected, or in the declared default.
      flagValue: (name) => {
        for (const env of Object.values(injected)) {
          if (name in env) return env[name] !== 'false' && env[name] !== '0' && env[name] !== '';
        }
        return undefined;
      },
      // No capture exists yet; this is the seam slice 4 fills.
      observedCount: () => 0,
    };

    const tally: Record<Evidence, number> = {
      observed: 0, wired: 0, documented: 0, gated: 0, missing: 0,
    };
    const flows = manifest.flows.map((flow) => ({
      ...flow,
      steps: flow.steps.map((step) => {
        const evidence = evidenceFor(step, ctx);
        tally[evidence] += 1;
        return { ...step, evidence };
      }),
    }));

    const nodes: Record<string, MappedNode> = {};
    for (const [name, node] of Object.entries(manifest.nodes)) {
      const state = live?.run.nodes[name];
      const providers = Object.keys(node.providers);
      const chosen = state?.provider;
      const provider = chosen ? node.providers[chosen] : undefined;
      nodes[name] = {
        kind: node.kind,
        providers,
        provider: chosen,
        status: state?.status,
        url: state?.url,
        // Runnable unless every provider it offers is paper.
        runnable: provider
          ? !provider.documented
          : providers.some((p) => !node.providers[p].documented),
      };
    }

    return { name: manifest.name, manifestPath, root, up: Boolean(live), nodes, flows, tally };
  }
```

Add the imports this needs at the top of `engine.ts`: `evidenceFor`, `type Evidence`, `type EvidenceContext` from `./evidence.ts`, and `type MappedNode`, `type WorkspaceMap` from `./types.ts`. `dependencyEnv` is already imported.

There is no private lookup returning a `LiveRun` today: `get(idOrPath)` at
`engine.ts:59-63` inlines the two-step resolution and returns the public
`WorkspaceRun`. `map` needs the `LiveRun` (for `#urls`), so extract that
resolution once and have `get` delegate to it:

```ts
  /** A live run by workspace id or by manifest path — clients have one or the other. */
  #live(idOrPath: string): LiveRun | undefined {
    const byPath = this.#runs.get(idOrPath);
    if (byPath) return byPath;
    return [...this.#runs.values()].find((live) => live.run.id === idOrPath);
  }

  /** A run by workspace id or by manifest path — clients have one or the other. */
  get(idOrPath: string): WorkspaceRun | undefined {
    return this.#live(idOrPath)?.run;
  }
```

Then `map` calls `this.#live(manifestPath)`. Behaviour is unchanged; the existing
tests for `get` and for `status` cover the refactor.

- [ ] **Step 5: Add the RPC and the handler**

In `src/core/api.ts`, beside the other workspace entries:

```ts
  /**
   * The map for a workspace: nodes, flows, and each hop's derived evidence.
   *
   * Answers whether or not the workspace is up, because the question a
   * newcomer asks first comes before they can start anything. Deliberately not
   * folded into `ProjectInfo`, which the app re-polls every three seconds.
   */
  workspaceMap: {
    params: { manifest?: string; cwd?: string };
    result: WorkspaceMap;
  };
```

Import `WorkspaceMap` alongside the existing `WorkspaceRun` import in that file.

In `src/daemon/server.ts`, beside the other workspace handlers, following the
exact shape of `workspaceUp` at `:753-762`. `readManifest` is already imported at
`:32`, so no new import is needed:

```ts
      case 'workspaceMap': {
        const params = p as RpcMethods['workspaceMap']['params'];
        const from = params.manifest ?? params.cwd;
        if (!from) throw new Error('which workspace? Pass a manifest path or a directory.');
        return this.workspaces.map(readManifest(from)) satisfies RpcMethods['workspaceMap']['result'];
      }
```

Unlike `workspaceUp`, this does **not** call `this.projects.remember(...)`:
reading a map is not starting work, and it should leave no trace in the project
list.

- [ ] **Step 6: Run the server test and watch it pass**

Run: `npm test 2>&1 | grep -A8 "answers from the manifest"`
Expected: PASS.

- [ ] **Step 7: Write the failing CLI test**

Add to `test/cli-workspace.test.ts`, matching how that file already invokes the CLI:

```ts
test('baton map prints every flow with its hops and a tally', async () => {
  const root = await writeWorkspace({
    name: 'Paper stack',
    nodes: {
      app: { kind: 'mobile', providers: { local: { documented: {} } } },
      api: { kind: 'backend', providers: { local: { documented: {} } } },
      mq: { kind: 'queue', providers: { mainframe: { documented: { note: 'z/OS' } } } },
    },
    flows: [{
      id: 'settle',
      name: 'Settle',
      steps: [
        { from: 'app', to: 'api', what: 'stop upload', cite: 'app/client.dart:408' },
        { from: 'api', to: 'mq', what: 'seven queues', cite: 'api/Queue.java:73',
          flag: { name: 'MQ_ENABLED', default: false } },
        { from: 'mq', to: 'api', what: 'unbuilt ack', missing: true, note: 'No consumer exists.' },
      ],
    }],
  });
  const out = await runCli(['map'], { cwd: root });

  assert.match(out, /Paper stack/);
  assert.match(out, /workspace down/);
  assert.match(out, /Settle/);
  assert.match(out, /app → api {2}stop upload {2}\[on paper\]/);
  assert.match(out, /MQ_ENABLED is off/);
  assert.match(out, /\[missing\]/);
  assert.match(out, /1 on paper · 1 gated · 1 missing/);
});
```

`writeWorkspace` and `runCli` are whatever this file already uses to write a
fixture and invoke the CLI — read the top of `test/cli-workspace.test.ts` and
reuse them by their real names.

- [ ] **Step 8: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A8 "baton map prints"`
Expected: FAIL — unknown command `map`.

- [ ] **Step 9: Add the command**

In `src/cli/index.ts`, add a printer beside `printWorkspace` (`:159-175`):

```ts
const EVIDENCE_LABEL: Record<string, string> = {
  observed: 'observed',
  wired: 'wired',
  documented: 'on paper',
  gated: 'gated',
  missing: 'missing',
};

function printMap(map: WorkspaceMap): void {
  console.log(bold(map.name) + dim(`  ${map.manifestPath}`));
  console.log(dim(map.up ? 'workspace up' : 'workspace down — nothing can be wired or observed yet'));

  for (const flow of map.flows) {
    console.log('');
    console.log(bold(flow.name) + (flow.source ? dim(`  ${flow.source}`) : ''));
    for (const step of flow.steps) {
      const label = EVIDENCE_LABEL[step.evidence] ?? step.evidence;
      const tail = step.evidence === 'gated' && step.flag
        ? dim(`  ${step.flag.name} is off`)
        : step.cite ? dim(`  ${step.cite}`) : '';
      console.log(`  ${step.from} → ${step.to}  ${step.what}  [${label}]${tail}`);
    }
  }

  const parts = Object.entries(map.tally)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${EVIDENCE_LABEL[kind] ?? kind}`);
  console.log('');
  console.log(parts.join(' · ') || 'no flows declared');
}
```

And the case, beside `up` / `down` / `switch`:

```ts
      case 'map': {
        const map = await client.call('workspaceMap', { cwd: resolve(positional[0] ?? cwd) });
        printMap(map);
        break;
      }
```

Import `WorkspaceMap` from `../workspace/types.ts`. Add `map` to the CLI's usage/help text wherever `up`, `down`, `switch` and `restart` are listed — search for one of those strings to find it.

- [ ] **Step 10: Run the CLI test and watch it pass**

Run: `npm test 2>&1 | grep -A8 "baton map prints"`
Expected: PASS.

- [ ] **Step 11: Expose it to agents**

In `src/mcp/index.ts`, beside `workspace_status` (`:84`), add a tool that forwards to the new RPC, following the exact shape of its neighbours:

```ts
  server.tool(
    'workspace_map',
    'Every declared data flow in a workspace and how strongly each hop is evidenced: '
    + 'observed (traffic seen), wired (Baton set the address), documented (cited in code only), '
    + 'gated (a feature flag is off) or missing (no implementation found). Works with the '
    + 'workspace down. Use this to understand what a system does before changing it.',
    { cwd: z.string().optional().describe('Any directory at or below the manifest.') },
    guarded(async ({ cwd }) => daemon().call('workspaceMap', { cwd })),
  );
```

- [ ] **Step 12: Everything green**

Run: `npm run typecheck && npm test`
Expected: `tsc` clean; all tests pass.

- [ ] **Step 13: Document it**

Append to `docs/launch-guide.md`, after the workspace commands section:

````markdown
## Flows: what talks to what

Nodes say what runs. `flows` say what *moves*, as named end-to-end paths:

```jsonc
"flows": [
  {
    "id": "capture-settle",
    "name": "Capture / settle",
    "source": "docs/architecture.md §6.4",
    "steps": [
      { "from": "app", "to": "order", "what": "stop capture upload",
        "cite": "app/lib/api/client.dart:408" },
      { "from": "order", "to": "db", "what": "capture + outbox row, one transaction",
        "cite": "order/FieldCaptureService.java:194" },
      { "from": "relay", "to": "mq", "what": "one syncpoint, whole-or-nothing",
        "cite": "relay/QueueClient.java:73",
        "flag": { "name": "MQ_ENABLED", "default": false } }
    ]
  }
]
```

`baton map` prints each flow with how strongly every hop is evidenced:

```text
Capture / settle  docs/architecture.md §6.4
  app → order  stop capture upload  [wired]
  order → db  capture + outbox row, one transaction  [observed]
  relay → mq  one syncpoint, whole-or-nothing  [gated]  MQ_ENABLED is off

1 observed · 1 wired · 1 gated
```

**Evidence is computed, never written.** A step may carry a citation, a flag, or
an admission that nothing is built (`"missing": true` with a `note`) — and
nothing else. `wired` means Baton itself injected the address joining the two
nodes; `observed` means it watched traffic cross. Neither can be put in the
file, so nobody can claim a hop is proven when it is not.

A hop crossing something Baton will never start — a mainframe, a queue manager —
needs that node declared with a `documented` provider, so the path does not
appear to stop early:

```jsonc
"mq": { "kind": "queue", "providers": { "mainframe": { "documented": { "note": "z/OS" } } } }
```
````

- [ ] **Step 14: Commit**

```bash
git add src/workspace/types.ts src/workspace/engine.ts src/core/api.ts src/daemon/server.ts src/cli/index.ts src/mcp/index.ts test/workspace-server.test.ts test/cli-workspace.test.ts docs/launch-guide.md
git commit -m "feat(workspace): baton map — flows and derived evidence, up or down"
```

---

## What this plan deliberately leaves out

Each is its own follow-on plan, in this order:

1. **The Drive360 manifest.** Writing `baton.workspace.json` with all nine flows, plus the `${VAR:-default}` edits to `compose.local.yml` / `compose.lab.yml` that Task 2 requires. Data, not code — and it wants Tasks 1–6 landed first so `wired` means something. Per spec §6 the umbrella folder is not a git repo, so the file is committed to `drive360-docs` and symlinked into `~/Documents/Drive360`.
2. **The map view.** The HUD add-on: flow mode reading top-to-bottom, topology mode at natural size, evidence as form first and colour second. Consumes `workspaceMap`.
3. **The onboarding skill.** Portable markdown that reads repositories in parallel, requires a citation per hop, cross-checks against existing docs and reports disagreements rather than resolving them.
4. **The shape diff.** Added / changed / removed hops against a baseline the mode distrusts and states.
5. **Observation (`observed`).** The OTLP receiver and Java-agent injection. `observedCount` is the seam it fills; until then it returns 0 and the rung is unreachable by construction.
