# Baton Master Plan

> **Working product strategy — not launch copy.**
>
> Baton is actively evolving. This document captures the full product direction so the
> implementation can mature before the public README and final positioning are rewritten.

## 1. The thesis

Software teams are giving coding agents more responsibility, but the basic act of running
software has become strangely inefficient.

Developers increasingly ask an agent to run `npm start`, watch a terminal, wait for a port,
read logs, restart a process, or take a screenshot. Those are deterministic computer tasks,
yet every terminal command, poll, and pasted log consumes model tokens, time, attention, and
money. The agent becomes an expensive shell wrapper while humans lose the simple operational
habits they already know.

At the same time, non-developers still struggle to run the product at all. Product managers,
QA, designers, support staff, and leaders often depend on a developer to turn a repository
into a working app, select the correct environment, start its dependencies, and explain
whether it is healthy.

**Baton should make running and verifying software a local product capability, not a repeated
conversation with an agent and not a privilege of an IDE.**

The long-term product is a local runtime and verification control plane shared by people,
coding agents, and automation.

```text
repository -> discover -> prepare -> run -> observe -> exercise -> compare -> prove
                                  ^                                 |
                                  +------------- repeat ------------+
```

The human can use a CLI or visual control surface. The agent uses structured tools. Both see
and control the same sessions, dependencies, logs, requests, devices, and proof artifacts.

## 2. The pitch to the world

### Category

**Local application runtime and verification control plane.**

Baton is not primarily another terminal, IDE, CI service, deployment platform, or AI coding
agent. It is the deterministic execution layer those products can share.

### One-line pitch

> Clone a repository and Baton gets it running, keeps it healthy, and proves what changed —
> for developers, agents, QA, and product teams.

### Developer pitch

> Stop spending agent credits on `npm start`, log polling, restarts, screenshots, and terminal
> babysitting. Baton runs the loop locally and gives your agent structured controls and evidence.

### Team pitch

> Give anyone on the team a safe Run button for the real product. Baton discovers how a
> repository works, prepares its local dependencies, starts the right services, and explains
> what is healthy or broken.

### Agent-platform pitch

> Give coding agents a reliable runtime API instead of asking them to emulate a human at a
> shell. Baton exposes typed operations for running, waiting, inspecting, comparing, and proving.

### Signature promise

```text
Clone it. Run it. See it. Prove it.
```

## 3. The problems Baton owns

### 3.1 Agent-credit waste

Agents should reason about code, architecture, and failures. They should not spend their
context repeatedly:

- discovering the right start command;
- running a long-lived process in a terminal;
- polling until it is ready;
- copying and re-reading unstructured logs;
- restarting after an edit;
- checking several terminals for dependent services;
- manually opening URLs or simulators;
- taking screenshots and assembling evidence;
- repeating the same test against another environment.

Baton converts these into deterministic local operations with structured results. This reduces
token consumption and latency while improving reliability. The goal is not to remove agents;
it is to spend agent intelligence where judgment is valuable.

### 3.2 Clone-to-running friction

A cloned repository often assumes undocumented knowledge:

- the right runtime and version;
- the correct package manager;
- which install command is safe;
- required environment templates;
- local databases, emulators, queues, or containers;
- service startup order;
- ports and health endpoints;
- device or simulator selection;
- seed data and migrations;
- several commands running at once.

Baton should discover and explain this state, then prepare it safely.

### 3.3 Runtime fragmentation

The app is in one terminal, a worker in another, Docker elsewhere, devices in an IDE, logs in a
third tool, and the agent has only partial visibility. Baton should provide one state model for
the whole local system without replacing the underlying tools.

### 3.4 Weak verification

“It runs” and “the tests passed” are not enough. Teams need evidence that the expected app or
service became ready, behaved correctly, avoided new errors, preserved its contract, and matched
an approved baseline.

## 4. Who Baton serves

### Developers

- One command or control surface for every project and service.
- Real hot reload/restart semantics where supported.
- Persistent sessions that survive terminal closure.
- Structured errors, logs, requests, devices, and status.
- Less terminal management and lower agent spend.

### Coding agents

- Typed operations instead of shell scraping.
- Honest capability discovery.
- Deterministic waits instead of polling.
- Small structured summaries before expensive log reads.
- Screenshots, request details, comparisons, and proof bundles.
- A stable feedback loop across edits.

### QA

- Clone and run approved targets without memorizing commands.
- Repeatable fixtures and environment profiles.
- Cross-device and cross-configuration verification.
- Saved proof bundles for bugs and releases.
- Easy reproduction with logs, requests, and screenshots attached.

### Product managers and designers

- A visual project launcher with clear environment names.
- No requirement to understand package managers or terminal process control.
- Safe access to real local builds and feature branches.
- Shareable evidence for product review.

### Engineering managers and support teams

- A reproducible way to start a repository.
- Fast validation of branches, fixes, and reported issues.
- Clear diagnosis of setup versus product failure.
- A common evidence format across people and agents.

## 5. Product principles

1. **Use what the repository already declares.** Detect existing standards before creating Baton
   configuration.
2. **Deterministic work should not consume model reasoning.** Run, wait, restart, collect, and
   package evidence locally.
3. **One shared source of runtime truth.** CLI, HUD, desktop UI, agents, and automation operate on
   the same daemon state.
4. **Capabilities must be honest.** Never claim hot reload, network visibility, readiness, or
   proof coverage that an adapter cannot provide.
5. **Local and safe by default.** Never silently target production, use cloud credentials, or
   perform irreversible setup.
6. **Explain before and while acting.** Users should see what Baton detected, what is missing,
   what it proposes to install, and why a step failed.
7. **Progressive complexity.** A simple app gets a Run button; a distributed system can expose a
   full service graph and proof plan.
8. **No lock-in.** Baton orchestrates existing commands and tools. Removing Baton does not make the
   repository unusable.
9. **Evidence over confidence.** Baton should return observable proof, not merely a success message.
10. **Humans remain in control.** Agents and automation get bounded capabilities; risky actions
    require explicit authorization.

## 6. The complete product loop

### Discover

Baton inspects a repository and builds an explainable project model from signals such as:

- `.vscode/launch.json` and `.claude/launch.json`;
- `package.json` and lockfiles;
- Flutter and Dart project files;
- Python, Go, Rust, Java, .NET, Ruby, and Elixir manifests;
- `Dockerfile` and Compose files;
- Make, Task, Just, and common script runners;
- monorepo/workspace configuration;
- test and integration-test conventions;
- health endpoints and service ports where declared;
- Google Cloud development and emulator configuration;
- checked-in environment templates and tool-version files.

`baton inspect` should show the reasoning:

```text
orders-api
  runtime       Node 24 (from .nvmrc)
  package tool  pnpm (from pnpm-lock.yaml)
  install       pnpm install --frozen-lockfile
  run           pnpm dev
  ready         GET http://127.0.0.1:8080/health
  dependencies  postgres, pubsub-emulator
  missing       dependencies are not installed
```

Discovery must never silently choose between ambiguous targets. It should present the candidates
or request a one-time project decision that can be saved.

### Prepare

Baton checks whether the machine and repository are ready:

- required runtime exists and meets the version constraint;
- repository dependencies are installed and consistent with the lockfile;
- expected local files exist;
- ports are available;
- containers or emulators are available;
- required environment values are present;
- migrations and seed state are understood;
- devices or simulators are available when needed.

Preparation is divided into safety classes:

#### Automatic and repository-local

These may be offered as a normal one-click preparation step because they are bounded and
reproducible:

- install dependencies using the detected lockfile and package manager;
- create ignored local files from explicit repository templates;
- build generated local artifacts;
- pull declared development containers;
- run a documented local bootstrap script;
- create local caches and Baton metadata.

The exact command and affected directory must remain visible. Teams may disable automatic
preparation or require confirmation for every step.

#### Explicit approval required

Baton must explain and request permission before:

- installing global packages or system software;
- changing shell profiles or operating-system settings;
- downloading or selecting a language runtime;
- using cloud credentials;
- connecting to non-local databases or services;
- running migrations or seed operations against shared environments;
- changing firewall, container, or virtualization settings.

#### Never automatic

- production credentials or production mutations;
- destructive database resets outside a clearly local disposable environment;
- secret generation or secret transmission without a defined destination and approval;
- arbitrary instructions discovered in logs, webpages, or untrusted repository content.

`baton doctor` should give a complete preparation report. `baton prepare` should execute the
approved plan and record what it changed.

### Run

Baton starts one target or an entire dependency graph, in order, and owns only the processes it
starts.

```bash
baton run web
baton up orders
baton up                    # approved default workspace
baton restart orders-api
baton stop worker
baton down
```

Run behavior includes:

- dependency ordering and parallel startup where safe;
- port and process ownership;
- readiness rather than a naive fixed sleep;
- reuse of compatible services already running;
- project-scoped session identity;
- process persistence outside an individual terminal;
- automatic HMR/fast-refresh awareness;
- capability-specific reload or restart;
- clean shutdown with escalation only when necessary.

### Observe

Every session should expose a cheap structured summary before a person or agent reads full logs:

- lifecycle status and uptime;
- readiness and health checks;
- current target, profile, device, and URL;
- dependency health;
- latest reload/restart result;
- recent errors;
- request and failure counts;
- resource warnings;
- test/probe status;
- known capability limitations.

The visual control surface should scale from a single Run button to a system graph while retaining
the compact HUD for developers who want it.

### Exercise

Baton should trigger repeatable behavior without embedding business-specific testing logic:

- existing unit, integration, end-to-end, and smoke-test commands;
- HTTP and gRPC probes;
- GraphQL operations;
- publish/consume event flows;
- deep links and browser routes;
- mobile interactions through external test runners;
- migrations and fixture setup in disposable local environments;
- user-defined scripts with structured exit criteria.

### Compare

The same probe can run against two approved targets:

```bash
baton compare local baseline
baton compare local staging
baton compare branch:feature branch:main
```

Comparison can include:

- HTTP status, headers, and structured body differences;
- schema or contract changes;
- ignored dynamic fields such as IDs and timestamps;
- screenshots and visual differences;
- logs and new error classes;
- request counts and dependency calls;
- latency and resource budgets;
- database or emulator state snapshots;
- test result differences.

Remote comparisons are read-only by default and require an explicit named profile. Baton must
redact secrets and sensitive data before persisting or sharing results.

### Prove

A proof run produces a durable evidence bundle:

```text
proof/
  summary.md
  proof.json
  topology.json
  sessions.json
  checks.json
  screenshots/
  requests/
  responses/
  logs/
  network-summary.json
  contract-diff.json
  performance.json
  test-results/
```

Proof matrices may cross:

- devices and platforms;
- light/dark appearance;
- text scale and locale;
- application configuration;
- service/runtime version;
- feature flags;
- local and approved remote references.

Every proof must describe its coverage and blind spots. For example, incomplete network capture
must be reported as incomplete rather than interpreted as zero requests.

## 7. Backend and Google Cloud direction

Baton should orchestrate development systems rather than reproduce cloud platforms.

### Service model

The existing target/session model grows into a service graph:

```jsonc
{
  "name": "orders-api",
  "run": "pnpm dev",
  "ready": { "http": "http://127.0.0.1:8080/health" },
  "dependsOn": ["postgres", "pubsub"],
  "environment": ".env.local",
  "proof": ["smoke", "contract"]
}
```

A service may be an API, worker, scheduled job, database, cache, queue, emulator, container,
frontend, mobile app, or test harness.

### Google Cloud development

Where repositories already use Google-provided emulators, containers, or local substitutes,
Baton can:

1. detect the declared emulator/dependency;
2. verify that its required tool is installed;
3. offer a safe installation or setup plan;
4. start it on a known local port;
5. inject local endpoint variables into dependent services;
6. create disposable local topics, subscriptions, buckets, datasets, or fixtures through
   repository-owned setup commands;
7. wait for readiness;
8. collect logs, health, requests, and proof artifacts;
9. stop only resources Baton owns.

Baton should also integrate with Docker Compose, local databases, and third-party emulators because
many GCP systems depend on services that have no complete official local emulator.

Cloud deployment remains outside the initial core. Cloud Build, infrastructure-as-code, and GCP
deployment products continue to provision and deploy. Baton may invoke an existing approved
repository command and observe it later, but its first responsibility is local execution and proof.

## 8. The zero-friction experience

### CLI-first developer flow

```bash
git clone <repo>
cd <repo>
baton run
```

If preparation is needed:

```text
Baton found a pnpm application, but dependencies are not installed.

  pnpm install --frozen-lockfile
  directory: /code/storefront
  source: pnpm-lock.yaml

Prepare this repository? [Y/n]
```

After preparation:

```text
✓ dependencies installed
✓ local environment created from .env.example
✓ development database ready
✓ storefront running at http://127.0.0.1:3000
```

### Visual flow for QA and product

The desktop experience should support:

1. Open a repository folder or paste a Git URL.
2. If needed, clone into a clearly shown destination.
3. See “Ready to run” or a plain-language setup plan.
4. Approve repository-local preparation.
5. Choose a friendly target/profile such as “Storefront — local demo data.”
6. Press **Run**.
7. Open the app, view health, or execute an approved proof scenario.
8. Export a proof bundle or bug report.

Technical details remain available but do not block non-developers. Errors should distinguish:

- machine setup problem;
- missing repository dependency;
- missing configuration or secret;
- dependency startup failure;
- application build failure;
- application runtime failure;
- verification failure.

### Team-owned run recipes

A repository may optionally publish friendly, reviewed recipes:

```text
Local demo
QA regression
Checkout flow
Offline mode
Production-like local stack
```

Recipes name existing targets, dependencies, fixtures, probes, and proof checks. They should be
code-reviewed and versioned with the product. Non-developers select a recipe rather than assembling
commands themselves.

## 9. Configuration strategy

### Level 0: no Baton configuration

Automatic detection provides immediate value for common projects.

### Level 1: existing project configuration

Baton reads launch files, scripts, Compose files, task runners, tool versions, and test conventions.

### Level 2: optional Baton project manifest

Only capabilities that cannot be inferred are declared: friendly recipes, readiness checks,
dependency relationships, safe preparation steps, proof scenarios, comparison rules, and redaction.

### Level 3: organization policy

Organizations can constrain:

- allowed preparation operations;
- remote environment access;
- secret providers;
- proof retention and redaction;
- approved recipes;
- agent permissions;
- package and container registries.

The manifest should compose existing commands rather than replace package managers, Compose, CI,
or infrastructure definitions.

## 10. Agent interface

Agents should receive a small, capability-oriented API rather than hundreds of shell primitives.

Core operations:

```text
inspect_project
prepare_project
list_targets
start_target / start_workspace
wait_for
session_summary
restart / reload / stop
read_logs
list_requests / get_request
run_probe / run_test
capture_screenshot
compare_targets
run_proof / get_proof
```

Agent-efficiency requirements:

- return structured summaries by default;
- make expensive logs and bodies opt-in;
- expose stable session and artifact identifiers;
- block deterministically instead of encouraging polling;
- surface compiler/runtime errors directly;
- report capability limits in every relevant result;
- keep long-running processes inside Baton rather than inside the agent tool call;
- allow a human to observe or take over the same session.

Success should be measurable as fewer model tokens and tool round trips per completed development
task, not merely more agent tool calls.

## 11. Safety, trust, and privacy

The clone-and-run promise requires a visible trust model.

### Repository trust

Cloned code can execute arbitrary commands. Baton must never imply that a repository is safe merely
because it was detected successfully. Before first execution, show:

- repository origin and destination;
- exact commands that will run;
- containers and packages that will be installed;
- files that will be created or modified;
- ports that will be opened;
- credentials and remote endpoints that would be used.

Teams may sign or approve recipes so users can distinguish reviewed workflows from newly discovered
commands.

### Secrets

- Prefer environment references and existing secret providers over copying values.
- Never put secrets in proof bundles.
- Redact authorization headers, cookies, tokens, and configured sensitive fields.
- Do not transmit local logs, requests, screenshots, or repository data without explicit action.

### Environment safety

- Localhost and disposable local resources are the default.
- Remote profiles are named and visibly marked.
- Production is denied by default.
- Mutating probes require explicit declarations and permission.
- Database reset/seed actions must identify the target and prove it is local or disposable.

### Process ownership

Baton records what it started, reuses external services only when safe, and never stops an unrelated
process merely because it uses a familiar name.

## 12. Product surfaces

### CLI

The precise, scriptable interface for developers and automation.

### Compact HUD

The always-available run/reload/status control surface. It should stay focused and small.

### Desktop workspace

A more guided product for cloning, preparation, service graphs, recipes, proofs, QA, and product
review. This is where non-developer accessibility should live rather than overloading the compact HUD.

### Agent server

The structured tool layer used by coding agents and agent platforms.

### CI bridge

Later, the same proof recipes may execute in CI. Local and CI outputs should use the same evidence
format, but Baton should first perfect the local loop.

## 13. Packaging and installation

### Baton installation

The project should eventually offer paths appropriate to each audience:

- package-manager installation for developers;
- a signed desktop application for QA/product users;
- a standalone or bundled runtime so non-developers do not first have to install Node;
- organization-managed distribution where required.

### Project dependency installation

Baton detects installation state using lockfiles, manifests, and tool-specific integrity signals.
It must avoid the false assumption that the existence of `node_modules` or a virtual environment
means dependencies are correct.

The preparation engine needs adapter-specific plans:

- exact package manager and locked/frozen mode;
- runtime/version check;
- clean versus incremental install policy;
- offline/cache awareness;
- install progress and cancellation;
- post-install health validation;
- a clear record of changes.

Automatic installation must stay repository-scoped unless the user explicitly approves a broader
machine change.

## 14. Roadmap

### Phase 0 — Preserve and stabilize the current wedge

Goal: make the existing Flutter/frontend loop trustworthy.

- stabilize daemon, sessions, HUD, history, network inspection, and proof bundles;
- keep capability reporting honest;
- harden packaging and release metadata;
- establish proof artifact and adapter contracts;
- measure startup, reload, and proof reliability;
- avoid premature README repositioning while capabilities are moving.

Exit criteria:

- install and first run work on supported platforms;
- core tests and real-project fixtures remain reliable;
- a coding agent can edit, reload, inspect, screenshot, and prove without terminal babysitting.

### Phase 1 — Clone-to-run preparation

Goal: turn setup failures into an explainable preparation plan.

- `baton inspect` and `baton doctor`;
- dependency-install state detection;
- repository-local `baton prepare`;
- runtime and package-manager version checks;
- environment-template handling;
- explicit preparation safety classes;
- visual setup flow and plain-language errors.

Exit criteria:

- a new machine can clone representative repositories and reach a running state with no undocumented
  manual steps;
- every machine-level or remote action is visible and approved;
- preparation is reproducible and diagnosable.

### Phase 2 — Backend service runtime

Goal: apply the same deterministic loop to APIs and workers.

- readiness checks for processes and HTTP services;
- backend framework detection and adapters;
- structured process health and error summaries;
- HTTP/gRPC probe runner;
- integration-test orchestration;
- Docker and Compose support;
- service restart and persistent logs.

Exit criteria:

- an agent can edit a backend, restart it, wait for readiness, run a probe, inspect the result, and
  return evidence without managing a shell session.

### Phase 3 — Workspaces and dependency graphs

Goal: run complete local systems.

- service/dependency graph;
- ordered and parallel startup;
- shared dependency reuse;
- databases, queues, caches, and emulator lifecycle;
- migrations and fixtures with safety boundaries;
- topology view in the desktop workspace;
- workspace-level status, restart, and shutdown.

Exit criteria:

- representative multi-service repositories start with one approved action;
- Baton can identify exactly which dependency caused a failed workspace startup.

### Phase 4 — Google Cloud local development

Goal: make GCP-backed repositories reproducible locally.

- detection of repository-declared GCP tooling and emulators;
- local endpoint and project configuration injection;
- seed/setup recipe integration;
- emulator readiness and lifecycle;
- mixed Compose/emulator workspaces;
- cloud-credential boundary enforcement;
- GCP-focused fixtures and documentation.

Exit criteria:

- a cloned GCP-backed service can run against an approved local stack without accidental access to
  production or shared cloud resources.

### Phase 5 — Compare and generalized proof

Goal: prove behavior, not only process health.

- structured probes and assertions;
- golden responses and ignore rules;
- API contract comparison;
- local-versus-baseline and approved local-versus-remote comparison;
- performance and dependency-call budgets;
- backend proof artifacts;
- redaction and proof retention policies.

Exit criteria:

- Baton can explain what changed between two versions or environments and attach reproducible
  evidence.

### Phase 6 — Team recipes and non-developer product

Goal: make real repositories safely usable by QA, product, design, and support.

- friendly versioned run recipes;
- signed/approved recipe trust state;
- repository cloning and branch selection in the desktop workspace;
- one-click preparation and run;
- scenario/proof catalog;
- proof and bug-report export;
- organization policies and managed distribution.

Exit criteria:

- a non-developer can clone an approved repository, run a named scenario, and share useful evidence
  without knowing the underlying commands.

### Phase 7 — CI and ecosystem

Goal: make Baton recipes portable beyond one laptop without becoming another CI platform.

- headless proof execution;
- shared local/CI artifact format;
- adapter SDK and conformance tests;
- organization plugin registry;
- integrations with agent platforms, CI systems, and issue trackers;
- opt-in aggregate reliability and credit-savings metrics.

## 15. Measures of success

### Activation

- time from clone to first healthy run;
- percentage of repositories requiring no Baton-specific configuration;
- percentage of setup failures with an actionable explanation;
- completion rate of the proposed preparation plan.

### Reliability

- successful start and clean-stop rate;
- readiness false-positive and false-negative rate;
- adapter capability accuracy;
- proof reproducibility across machines;
- percentage of failures correctly attributed to setup, dependency, build, runtime, or verification.

### Agent efficiency

- model tokens used for run/observe/restart work before and after Baton;
- tool round trips per verified change;
- time agents spend polling;
- percentage of development loops completed without a human managing terminals;
- percentage of agent claims accompanied by proof artifacts.

### Team accessibility

- successful first run by QA/product users;
- number of approved recipes used outside engineering;
- time to reproduce a reported bug;
- percentage of review requests containing usable evidence.

### Product value

- weekly active repositories and sessions;
- proof runs per active repository;
- repeat usage across multiple projects;
- number of services managed per workspace;
- retained teams after initial setup.

## 16. Business and go-to-market direction

The open-source local runtime can establish trust and broad framework support. Paid value can emerge
around coordinated teams rather than restricting the core run loop:

- organization policy and approved recipes;
- managed desktop distribution;
- signed recipe and adapter registries;
- shared proof retention and review;
- audit controls and secret/redaction policies;
- fleet setup visibility and environment diagnostics;
- enterprise support and custom adapters.

The initial story should be won with a concrete wedge:

> The fastest, most reliable way for a coding agent to run and verify a Flutter application without
> wasting credits or depending on an IDE.

Then expand the demonstrated loop to frontend applications, backend services, GCP-backed systems,
and non-developer team workflows. The broad vision becomes credible through successive working
proofs, not through a broad launch claim.

## 17. Non-goals and boundaries

Baton should not initially become:

- a code editor or coding agent;
- a general terminal replacement;
- a new package manager;
- a container orchestrator competing with Kubernetes;
- an infrastructure-as-code system;
- a cloud deployment platform;
- a full observability backend;
- a test framework that replaces repository-owned tests;
- a secret manager;
- an unbounded remote-computer automation system.

Baton connects these systems into a coherent local development and verification loop.

## 18. Decisions to validate before final positioning

1. Does the strongest initial customer identify with “save agent credits,” “remove the IDE,” or
   “clone-to-running”? Each is valuable, but one must lead.
2. Is Flutter the explicit launch category or the first proof point inside a broader local-runtime
   category?
3. How much repository-local installation can happen by default without reducing trust?
4. Should the optional manifest live in a Baton-specific file or extend existing launch/task
   conventions?
5. Which backend stack provides the best first end-to-end service-graph case study?
6. Which GCP-backed repository can serve as the reference emulator and proof workflow?
7. Which proof artifact is valuable enough that teams will attach it to every review?
8. What signed or reviewed recipe mechanism is required before inviting non-developers to run cloned
   repositories?
9. Can Baton measure credit savings accurately without collecting sensitive agent conversations?
10. What belongs in the compact HUD versus the larger desktop workspace?

## 19. Immediate next work

1. Keep the README focused on capabilities that are already dependable; defer the full rewrite.
2. Treat the existing proof bundle as the seed of the cross-stack evidence format.
3. Design `inspect`, `doctor`, and a preparation-plan data model before implementing automatic
   installation.
4. Add readiness as a first-class generic session capability.
5. Choose one backend reference repository and implement the complete loop:
   clone -> prepare -> run -> wait -> probe -> inspect -> prove.
6. Choose one GCP-backed reference repository and map its local dependencies and safety boundaries.
7. Prototype the guided desktop clone-and-run experience with QA/product users.
8. Benchmark the same agent task with and without Baton, measuring tokens, tool calls, latency, and
   human interventions.

The product is successful when running software becomes boring again: people press Run, agents call
a deterministic tool, the correct local system starts, and everyone receives evidence they can trust.
