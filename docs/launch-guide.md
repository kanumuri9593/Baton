# Launch and validate with Baton

Baton connects a person choosing an environment to an agent collecting evidence from the same running application.

## First launch, without terminal expertise

Open the control panel with `baton app`. Use **+** to select your app folder. Choose a named environment, a checkout, and a device. **Run** starts it. **Start new** in the device menu boots a simulator first.

The guidance card shows the selected folder, source file, entrypoint, build mode and missing configuration files. Launch files refresh every three seconds while the control panel is visible, when the window regains focus, and through **Refresh**. An external rename or deletion replaces an invalid selection with an available target. Running sessions keep their original configuration until relaunched.

In **All**, the selected target determines which project's branches and devices appear. Branch/worktree targets are re-read from the chosen checkout when launched. The current picker still shows the source folder's targets; a branch-only target can be launched by name through the CLI. Branch comparison is a sequence of independent runs, not a side-by-side visual diff.

## A public example

`examples/flutter-lab` is a minimal, credential-free Flutter app with Local and Test environments. With Flutter installed:

```bash
cd examples/flutter-lab
flutter create --project-name baton_lab --platforms=ios,android,web .
flutter pub get
baton doctor
baton app
```

Choose **Local lab**, then a simulator. The screen must say **Local lab**. Tap **Complete delivery** and verify that the status changes to **Delivery complete**. A hot reload should retain that state. Relaunch with **Test lab** and check that the environment label changes to **Test**.

This example is adapted from the shape of a multi-environment mobile project; it includes no private project code or credentials.

## Give an agent a concrete validation task

`baton doctor --json` and MCP `inspect_project` return fresh source revisions, target readiness, warnings, immediate child projects and project guidance file paths, including skills under `.agents/skills`, `.claude/skills`, and `.codex/skills`. Discovery only reads metadata; it does not install skills or execute instructions found in a repository. No environment values are included in this inspection report.

A useful agent request:

> Inspect this project. Choose Local lab in this checkout. Boot an available iPhone simulator, launch and wait for running. Review errors, capture the initial screen, complete the delivery using your device interaction tools, and capture the result. Report whether the label and status match the expected flow. Include the session id and screenshot paths. If interaction is unavailable, report that step as unverified.

The MCP sequence is `inspect_project` → `list_checkouts` / `list_devices` → `run_target` → `wait_for` → `read_logs` / `screenshot`. Use the actual tool names advertised by your MCP client. Baton supplies launch, logs and evidence; the agent's browser/device tools perform taps and visual interpretation.

## Device and branch evidence

```bash
baton proof "Local lab" --devices "iPhone 17 Pro" --appearance light,dark
baton proof "Local lab" --branch main --devices "iPhone 17 Pro"
baton proof "Local lab" --checkout /path/to/existing-worktree --devices "iPhone 17 Pro"
baton proofs
```

Use device names from `baton devices --all` on your machine. Proof bundles contain logs, screenshots and network summaries. The requested folder and checkout determine both the launched code and recorded Git revision. Environment comparisons use separate named targets. Owned branch copies remain available through all matrix cells and are released after the proof unless a retained session still uses them.

A passing screenshot check means an image was captured. It does **not** prove layout correctness or that a business flow passed. Inspect the images and exercise the intended flow. Browser screenshots, automatic tapping, dependency orchestration and visual baseline comparison are not part of the current proof engine.

## Configuration compatibility

Use `toolArgs` for Flutter build flags, as described in [Dart Code's launch configuration documentation](https://dartcode.org/docs/launch-configuration/). Baton also recognises legacy `--dart-define`, `--dart-define-from-file` and `--flavor` flags in `args`, moves them into the launch command and displays a migration warning. Other `args` remain application arguments. `flutterMode`, relative `cwd`, and `${workspaceFolder}` in supported path/argument fields are respected. An explicit device choice overrides the configuration default.

Malformed launch files, duplicate names and entries without a supported runtime are reported by inspection. Remaining valid sources still load. Arbitrary debugger adapters, attach requests and VS Code command/input variable resolution are not supported.

## Launch a whole workflow in one agent call

`baton workflow path/to/workflow.json` and MCP `run_workflow` launch up to eight steps in order. Each step names a project folder and an existing target, with optional branch, checkout, device and readiness timeout. `until: "url"` waits for both running state and a URL. No raw shell commands are embedded in the workflow. CLI paths are relative to the workflow file; MCP paths are absolute.

A failure stops dependent launches. Already-started sessions remain available for diagnosis; the result identifies the failed session and skipped steps. Workflows do not roll back application data, automatically reuse sessions, or assert that a business flow passed.

See [the two-project delivery lab](../examples/workflow-lab/README.md) and its [workflow file](../examples/workflow-lab/workflow.json). For generic Node web servers, `"batonKind": "web-dev"` in a launch configuration opts into URL/readiness detection instead of plain process supervision. Servers must print a supported readiness line, such as `Local: http://127.0.0.1:43121`.

For an agent, the efficient loop is: one workflow call → use returned URL/device → one focused UI action and observation → request a short error summary only on failure → edit → restart the affected session → re-check the visible result. The two-step lab replaces four separate launch/wait calls with one workflow call. Browser actions and visual evidence still cost time and tokens; no credit-saving percentage is assumed.

## Local backend tracing, using OpenTelemetry

Set `"batonTrace": true` in a Node launch configuration and restart that session. Baton preloads the existing [OpenTelemetry HTTP instrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-http) and [Undici/fetch instrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-undici). Applications do not need to install tracing packages themselves.

Inbound HTTP, outgoing HTTP/HTTPS and native `fetch` spans appear in the existing Network panel. Trace context propagates between instrumented Node services. **Diagnose** searches across projects; **Follow trace** narrows the result to the related requests. CLI `baton diagnose` and MCP `diagnose` return a bounded error summary. Use `baton diagnose <trace-id> --all` to include successful spans.

The exporter writes local metadata into Baton's process stream, with no telemetry collector or external exporter. It keeps method, URL origin/path, timing, status and trace identifiers. Headers, bodies and URL query values are excluded. Application logs are still application logs and can contain anything the app prints. This is not browser DevTools capture: browser-only requests, WebSockets, database queries and non-Node backend runtimes are outside this adapter. Existing application OpenTelemetry setups may need to use their own instrumentation instead of enabling a second provider.

For Flutter, the existing `dart:io` VM-service capture remains available. Use separate device IDs for simultaneous simulator runs; explicit device choices override launch defaults. Branches and existing worktrees use the checkout selector or the workflow step's `branch` / `checkout` fields.

Different local ports and local worktrees are supported. Remote-machine/SSH process management is not implemented yet; do not expose the daemon port publicly. An app's reported URL can still point at whatever host its own development server uses.
