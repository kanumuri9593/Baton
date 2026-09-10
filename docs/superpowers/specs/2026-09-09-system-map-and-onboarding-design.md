# The system map: making a backend judgeable by looking at it

Date: 2026-09-09
Status: draft, pending review.
Supersedes sub-projects 2 and 3 of [the workspace engine design](2026-09-09-workspace-engine-design.md)
("Topology view", "Discovery → manifest"), which this folds into one design with a new evidence model.

## Context

The workspace engine shipped: `baton.workspace.json`, providers (`target` / `compose` / `remote`),
dependency-ordered bring-up, readiness probes, health, `up/down/status/switch/restart`, RPC + push +
MCP, node rows in the control panel. What it cannot do is tell you what the system *does* — only
what is running.

The gap this design closes was named by the user, and it is not a tracing gap:

> "frontend is easy, it's clear and logical, I see and judge based on what I see. the quality
> backend how happens unseen — now with agents all unseen, which I don't like."

Frontend work is judgeable because it gives continuous visible feedback: change a thing, look, judge.
Backend work has no equivalent surface, so a person directing agents through a stack they are not an
expert in has no way to audit the result except to trust prose about code they cannot read. That is
the actual problem. Distributed tracing is one way to earn part of the picture; it is not the picture,
and it only ever covers the fraction of a system a laptop can run.

The reference system is Drive360 (`~/Documents/Drive360`): seven Azure DevOps repositories — a Flutter
driver app, three Spring Boot services, a Quarkus BFF, an Angular webapp, a Next.js dev console —
reaching Cloud SQL, GCS, Pub/Sub, four Azure Container Apps, IBM MQ and DB2 on z/OS. Roughly half the
system can never run on a developer's machine. A map that omits that half would lie by omission.

## Decisions taken during brainstorming

- The unit of the map is a **named flow** (an ordered path), not a bag of edges. The user thinks in
  flows; Drive360's own docs already number nine of them.
- **Evidence is derived, never authored.** No one can write `observed` into the manifest. This is
  the load-bearing decision: it is what stops a confident agent from manufacturing confidence.
- Five states, in override order: `missing` > `gated` > `observed` > `wired` > `documented`.
- A fourth provider kind, `documented`, for nodes that are real and unrunnable (IBM MQ, DB2, Apigee,
  PeopleNet, OnBase). Drawn always, started never, probed never.
- Discovery is an **agent skill**, portable across Claude Code / Codex / Cursor, because reading seven
  repositories and inferring flows is judgment work. Baton supplies the schema and the verbs.
- **A step with no citation is not written into the map.** Uncited inferences go to a separate list
  for a human.
- The map is committed, so a change to the system's shape is a `git diff`.
- No tracing in this design. Observation is slice 4.

These were validated by running the skill's read phase by hand against Drive360 before writing this
spec: six agents, one per repository, each required to cite `file:line`. It found six disagreements
between the code and the program's own architecture documents, including a High-severity gap on the
team's "take to the architect" shortlist that had already been built and switched off behind a flag.
The approach works; the anti-fabrication rule is what made the output trustworthy enough to check.

---

## 1. Manifest additions

Two additions to `baton.workspace.json`, both backward compatible — a manifest without them parses
and behaves exactly as today.

### 1.1 A `documented` provider

`providerSchema` currently refines to "exactly one of `target`, `compose`, `remote`"
(`src/workspace/manifest.ts:41-44`). It gains a fourth:

```jsonc
"ibm-mq": {
  "kind": "queue",
  "providers": {
    "mainframe": {
      "documented": { "note": "Reached only through the ported MainframeQueueClient." }
    }
  }
}
```

A `documented` provider is never started, never stopped, never probed, and never counted as a
failure. `NodeStatus` gains `documented` alongside the existing eight (`src/workspace/types.ts:19-28`).
It is distinct from `external`, which means *running, but not ours to stop*.

### 1.2 A `flows` section

```jsonc
"flows": [
  {
    "id": "capture-settle",
    "name": "Capture / settle",
    "source": "drive360-docs/01-architecture.md §6.4",
    "steps": [
      { "from": "mobile", "to": "order",
        "what": "stop capture upload",
        "protocol": "http",
        "queued": true,
        "cite": "drive360-mobile-app/lib/api/client.dart:408" },
      { "from": "order", "to": "cloudsql",
        "what": "capture + outbox row, one transaction",
        "protocol": "jdbc",
        "cite": "drive360-retail-order-service/.../FieldCaptureService.java:194" },
      { "from": "writeback", "to": "ibm-mq",
        "what": "7 queues, one syncpoint, whole-or-nothing",
        "protocol": "mq",
        "flag": { "name": "MAINFRAME_MQ_ENABLED", "default": false,
                  "note": "false locally; true in the deployed dev pipeline" },
        "cite": "drive360-retail-writeback-service/.../MainframeQueueClient.java:73" }
    ]
  }
]
```

Field rules, enforced by the schema:

| Field | Rule |
|---|---|
| `from` / `to` | must name declared nodes; validated with the graph, like `dependsOn` |
| `what` | required, one phrase — this is the label a reader sees on the edge |
| `cite` | `path:line`, repo-relative. Required unless `missing` is true |
| `flag` | optional; presence plus `default: false` is what produces `gated` |
| `queued` | optional; marks a hop that drains from a local queue and is never synchronous |
| `missing` | optional; requires `note`, forbids `cite` |
| `wiredBy` | **not authored** — derived, see §2 |

Flow steps deliberately do **not** feed `dependsOn`. Bring-up order and data flow are different
questions: the write-back service depends on Cloud SQL to start, but the data flows
order → Cloud SQL → write-back. Conflating them is how topology diagrams become wrong.

`MAX_NODES` is 24 (`manifest.ts:8`); flows get `MAX_FLOWS = 32` and `MAX_STEPS_PER_FLOW = 24`.

## 2. Deriving evidence

One pure function, `evidenceFor(step, run, traffic)`, in a new `src/workspace/evidence.ts`.
It is pure so it is testable without Docker, matching the engine's existing seam discipline.

Resolution order, first match wins:

1. **`missing`** — `step.missing` is true. No implementation was found. Overrides everything: a hop
   that does not exist cannot be observed.
2. **`gated`** — the step declares a flag whose effective value in this run is false. Overrides
   observation, because a flag being off is a fact about the environment that a healthy pair of
   endpoints does not change. This is the state that answers *"why is no data reaching the mainframe?"*
3. **`observed`** — traffic was captured crossing this hop during this run. Not reachable until
   slice 4; the field exists now and always reads false.
4. **`wired`** — Baton itself injected the env var that joins these two nodes, and both are up.
   Computed from `dependencyEnv` (`src/workspace/exports.ts:39-49`) against the live run: a hop is
   wired when Baton set a variable on one of its endpoints whose value is the other endpoint's URL.
   The match is direction-agnostic on purpose. For a push hop the caller holds the callee's URL
   (`mobile` holds the order service's); for a **pull** hop it is the other way round — the
   write-back service polls the outbox, so the consumer of `SPRING_DATASOURCE_URL` is the `to` end,
   not the `from` end. Requiring the caller to hold the URL would silently mark every polling hop
   unwired. Nothing is guessed either way; Baton knows what it set.
5. **`documented`** — none of the above. The hop rests on its citation alone.

The asymmetry is the point and must be preserved in review: **an agent authoring a manifest can only
ever produce `documented`, `gated` or `missing`.** `wired` comes from Baton's own bookkeeping and
`observed` from the runtime. Neither is expressible in the file.

Flag values are read from the same place Baton already reads env: the resolved provider environment
for the node that owns the flag, falling back to the declared `default`. A flag Baton cannot resolve
is reported as unknown rather than assumed on.

## 3. Engine changes this depends on

These are small, and `wired` is not truthful without the first two.

### 3.1 `dependencyEnv` must reach compose nodes

`src/workspace/engine.ts:226` computes `dependencyEnv(...)` and then passes it **only** to
`runTarget` at `:248`. The compose branch at `:229-239` silently discards it. Consequence today:
`baton switch retail-order cloud` tears the container down, marks the node external and restarts the
BFF — but the BFF's compose file hardcodes `RETAIL_ORDER_SERVICE_URL`, so it still talks to the
service that is gone. The headline capability does not work for containers, and Drive360 is almost
entirely containers.

Fix: pass the computed env as the environment of the `docker compose` invocation so Compose's own
`${VAR}` interpolation resolves it. Consuming projects change
`RETAIL_ORDER_SERVICE_URL: http://retail-order:8080` to
`${RETAIL_ORDER_SERVICE_URL:-http://retail-order:8080}` — defaults preserved, so a plain
`docker compose up` behaves exactly as before.

### 3.2 Compose files must layer

`composeRefSchema` takes a single `file` (`manifest.ts:18-21`) and `ComposeSessionOptions.file` is one
string (`src/adapters/compose.ts:7`). Compose layers natively and Drive360 relies on it
(`compose.lab.yml` holds an override fragment for `bff` that is meaningless alone). `file` accepts a
string or an array; the adapter emits repeated `-f` in order.

### 3.3 A regression test for the thing that was broken

`switch` must be proven to rewire a **compose** dependent, not only a `target` one. The existing
suite only covers targets, which is why 3.1 went unnoticed.

## 4. The onboarding skill

`skills/workspace-onboarding/SKILL.md` — markdown plus Baton MCP calls, so it runs unchanged under
Claude Code, Codex or Cursor. Five phases, with a human gate before anything is written.

**Connect.** Find the repositories: an umbrella folder already on disk, or clone them. Cloning is a
network and disk action and is confirmed first, listing what will be fetched and where.

**Read — in parallel, one agent per repository.** Each returns a structured fragment: stack, ports,
health endpoint, inbound endpoints, outbound hops (destination, protocol, what moves, the env var
holding the address, the flag gating it), the config surface, and the feature flags with their
per-profile defaults. Every line requires `file:line`. Each fragment ends with an explicit
**Uncertain** section; the prompt says accuracy beats completeness and forbids guessing.

**Merge.** Join fragments where one repo's *produced* URL matches another's *consumed* env var. That
join is what discovers most hops, and it is mechanical rather than inferential, which is why it is
reliable. Flags are collected into one inventory across repos.

**Self-check.** Where the project has its own architecture notes, diff the inferred flows against
them and **report disagreements rather than resolving them**. On Drive360 this phase alone surfaced
six, two of which change what the team should work on next. Silent reconciliation would have
destroyed the most valuable output of the whole exercise.

**Propose.** Emit a draft manifest and flows for review. Uncited inferences are listed separately as
"could not verify" and are *not* written into the map. The human approves before anything lands.

## 5. The map view

A HUD add-on, `src/hud/assets/map.js`, registered in `HUD_ASSETS` (`src/hud/render.ts:42-54`) and
`index.html`, following the add-on contract that `test/hud.test.ts:54-112` enforces: everything
through `window.baton`, DOM via `createElement` + `textContent`, named SVG icons, no bundler, and no
feature-specific RPC in `core.js`.

**Two layout modes**, both validated against the real Drive360 data in the design prototype:

- **Flow mode** (default) reads **top to bottom**: depth becomes the row, so following a path is
  following a column downward, and parallel branches sit side by side. A horizontal layout was tried
  first and is wrong — a six-hop linear flow lays out as a strip roughly 1340 wide by 140 tall,
  which squashes node text to about a third of its size when scaled to fit a panel.
- **Topology mode** is the full graph at natural size in a horizontally scrolling container. It must
  not scale to fit; at Drive360's size that shrinks node labels to about 8px.

Evidence reads as **form first, colour second** — solid for observed, solid-thin for wired, dashed
for documented, dashed for gated, broken with an open arrowhead for missing — so the encoding
survives colourblindness and greyscale. Colour uses one hue ramp for the confidence ladder and two
separate semantic hues for the two attention states.

Clicking a hop shows its citation; clicking a node shows its providers and its inbound/outbound hops.
The legend sits above the map, because a key below an 800px-tall diagram is not a key.

### 5.1 The shape diff

A third mode, and the one that gives backend work the loop frontend already has: what did this
branch do to the shape of the system? Hops added, hops removed, and hops whose endpoints are
unchanged but whose behaviour is not. Because the map is a committed file, the diff of the map is
the diff of the system's shape — but the useful version reads the repositories directly, so it works
before anyone has committed a map at all.

In this mode the evidence encoding is replaced wholesale — added / changed / removed become the
only colours — rather than layered on top of it. Two encodings on one line is how a diagram becomes
unreadable.

**The mode must state its baseline, and distrust it.** Running this against Drive360 produced three
results that would each have made a silent diff actively misleading:

- Two repositories' feature branches have **zero commits**; all the work is uncommitted files. A
  commit-range diff reports "no changes" for a substantial feature.
- The mobile repository's `main` is a **README-only stub** (2 commits; merge-base
  "Updated README.md"). Diffing against it reports 1179 commits. The real base is
  `origin/development`, at 41.
- One repository is on `main` with nothing to compare.

So the diff view leads with a per-repository baseline panel — branch, commits ahead of *which* base,
working-tree state — and flags a baseline it does not trust rather than quietly diffing against it.

**One new RPC**, `workspaceMap(path)`, returning nodes, flows and derived evidence. Deliberately not
an extension of `ProjectInfo.workspace` (`src/core/api.ts:65`): the project list is polled every
three seconds (`src/hud/assets/core.js:977`) and the map must not ride along on that. It reads the
manifest from disk, so it works with the workspace **down** — which is most of the value, since a
newcomer's first question comes before they can start anything.

## 6. Where the map lives

Drive360's umbrella folder is not a git repository; the seven sub-repos are. A committed manifest
therefore has no obvious home. Default: commit it to `drive360-docs` and symlink it into the umbrella
folder, so one team shares one map. Baton must not assume the umbrella folder is a repo —
`findManifest` (`manifest.ts:126`) already walks parents and does not care, so this is a
documentation decision, not a code one.

## 7. Testing

Repo conventions: `node:test`, `BATON_HOME` temp dir before dynamic import, injection over mocks, no
Docker or simulator in CI.

- Pure: manifest validation for flows (unknown node refs, missing citation, `missing` without a note,
  step limits); `evidenceFor` across every resolution-order pair, especially that `gated` beats
  `observed` and `missing` beats everything.
- `wired` derivation against a fake run: a hop is wired only when Baton actually set the var and both
  ends are up; not wired when the var came from the compose file itself.
- Engine: `dependencyEnv` reaches a compose node; `switch` rewires a compose dependent (§3.3);
  multi-file compose emits exact `docker compose -f a -f b` argv.
- `documented` nodes: never started by `up`, never stopped by `down`, never probed, never fail a
  workspace, and reported in `status`.
- HUD asset text contracts, as in `test/hud.test.ts`; layout functions unit-tested through a
  hand-written `.d.ts` sibling like `workspace.js` / `workspace.d.ts`.
- End to end: the real `~/Documents/Drive360` manifest through the daemon, asserting the tally the
  design prototype produced from the same data.

## 8. Out of scope

Tracing, the OTLP receiver and Java-agent injection (slice 4 — this design's `observed` rung is
defined but always false until then); per-repository agent sessions; multi-repo PR creation; any
automatic edit to a committed map without human approval; secret handling beyond passing env; and
authenticated or tunnelled `remote` providers — cloud stays wiring-and-health only, as decided.

---

## Appendix: what the read found on Drive360

Recorded because it is the evidence that this design is worth building, and because each item is a
real defect the team has not yet acted on.

| # | Finding | Cited at |
|---|---|---|
| D-1 | Launch config `Dev / Retail (local GCP)` passes `RETAIL_GCP_BASE_URL`, which exists nowhere in the app; the only override read is `LOCAL_RETAIL_URL`. The config silently hits the shared dev cloud. | `.vscode/launch.json:51` vs `lib/api/environment.dart:201` |
| D-2 | Gap G-E and architecture-map G11 (High, on the architect shortlist) both state the BFF has no location client. It has one, plus the SSE route, plus a Leaflet map in the webapp — all of it **untracked**, on a branch with zero commits. The documents are right about the repository and wrong about the world. Two teams are scheduling work that is finished on one laptop. | `?? client/location/`, `?? resource/RoutePositionsResource.java`, `application.yml:13` |
| D-3 | Docs place the six MQ queues in the write-back service. It declares none — the queue name is a per-row value; all seven names are constants in the order service. | `MainframeOutboxMessage.java:53`, `FieldCaptureService.java:44-45`, `DeliveryCompleteService.java:47-57` |
| D-4 | Two services drain the same outbox with no row lock in either; only a same-named flag being off keeps them apart. | order `OutboxRelay.java:36`, writeback `OutboxStore.java:31-40` |
| D-5 | The flag inventory lists `MAINFRAME_MQ_ENABLED` as off; the dev pipeline sets it true, and a comment four lines above still promises it stays false. | `azure-pipelines.yml:82`, comment at `:78` |
| D-6 | `MAINFRAME_MQ_BATCH_SIZE` is declared, defaulted, documented and contract-tested, and read by no code. The BFF's dev profile hardcodes the retail URL, so `RETAIL_ORDER_SERVICE_URL` has no effect there. | writeback `application.yml:46` vs `OutboxStore.java:32-40`; bff `application-dev.yml:27-29` |

A second pass diffed each repository against its baseline, which produced the shape-diff dataset
(11 hops added, 4 changed, 2 removed) and three more findings worth naming:

| # | Finding | Cited at |
|---|---|---|
| D-7 | AD-71 takes DB2 off the driver's synchronous path: the claim is decided in Cloud SQL and the same three procs are owed asynchronously. The architecture doc still says the driver waits — and so did the first draft of this map, until the diff caught it. | `finalize/LoadClaimService.java:62-139`, `finalize/MainframeAssertWorker.java:62-132`, `V17__load_claim.sql` |
| D-8 | The webapp's new map pulls tiles straight from the public OpenStreetMap CDN — hardcoded, behind no config key, from the user's browser. Every pan leaks the area a McLane user is viewing to a third party, and there is no CSP allowance or self-hosted alternative. | `live-location.ts:88` |
| D-9 | `RetailImageReader` fetches a route's stops and then issues one call per stop, and the BFF change lets a routeId-only request trigger it. An N+1 fan-out to the retail service, unbounded by stop count. | `service/RetailImageReader.java:20-24`, `service/ImageService.java:108` |

Also noted, outside the map's scope: `LOCATION_SERVICE_URL` has no non-local default in any profile,
so a dev or test deploy would fall back to `http://localhost:8083`; the new `EventSource` stream
cannot attach an `Authorization` header, unlike every other call the webapp makes; a live Apigee API key committed in
`drive360-mobile-app/.vscode/launch.json`, a hardcoded fallback Ditto JWT at
`lib/api/environment.dart:74-75`, and label rendering posted to `http://api.labelary.com` over plain
HTTP with no auth (`lib/utils/printer.dart:214-223`).

Design prototype of the view, built from this data:
<https://claude.ai/code/artifact/c65f3ee2-7d0d-4a02-8cea-1c909ae4602a>
