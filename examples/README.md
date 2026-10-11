# Examples

Small, credential-free projects to try Baton on. Both ship with the npm package.

| Example | What it is | How to run it |
|---|---|---|
| [flutter-lab](flutter-lab/README.md) | A minimal Flutter app with two environments (**Local lab** and **Test lab**) in `.vscode/launch.json`. Tap **Complete delivery**, hot reload, and check the state is kept | `cd flutter-lab && flutter create --project-name baton_lab --platforms=ios,android,web . && flutter pub get`, then `baton run "Local lab" --device <simulator-id>` |
| [workflow-lab](workflow-lab/README.md) | Two Node projects, a delivery API and a browser console, launched in dependency order by one workflow. No dependencies beyond Node 24+ | `cd workflow-lab && baton workflow workflow.json` (MCP: `run_workflow` with absolute paths) |

From a clone of this repository you can run the workflow without installing Baton:
`node src/cli/index.ts workflow examples/workflow-lab/workflow.json`.

## A minimal launch config

Baton reads `.vscode/launch.json` (or `.claude/launch.json`, same format) without changing it,
so the same file keeps working in VS Code and Cursor. Comments and trailing commas are allowed.
`baton init` writes one from what it detects in a folder.

Flutter (`"type": "dart"` gets real hot reload):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Local lab",
      "type": "dart",
      "request": "launch",
      "flutterMode": "debug",
      "program": "lib/main.dart",
      "toolArgs": ["--dart-define=APP_ENV=Local lab"]
    }
  ]
}
```

A Node dev server (any other `type` is supervised as a process):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Delivery API",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "node",
      "runtimeArgs": ["server.mjs"],
      "env": { "PORT": "43121" },
      "batonKind": "web-dev",
      "batonTrace": true
    }
  ]
}
```

Baton-only fields, ignored by VS Code:

| Field | Effect |
|---|---|
| `batonKind` | `web-dev`, `react-native`, `ios`, `android` or `process`. `web-dev` turns on URL and readiness detection for a generic server; it must print a line such as `Local: http://127.0.0.1:43121` |
| `batonTrace` | `true` preloads OpenTelemetry HTTP and `fetch` instrumentation for a Node process, so its requests appear in the Network panel and `diagnose` |

Also respected: `cwd` (relative to the project), `${workspaceFolder}`, `env`, `args`,
`deviceId` and `flutterMode`. More in the [launch and validation guide](../docs/launch-guide.md).

## A minimal workflow

```json
{
  "name": "Delivery end-to-end",
  "steps": [
    { "name": "API", "cwd": "./api", "target": "Delivery API", "until": "url" },
    { "name": "Console", "cwd": "./console", "target": "Delivery console", "until": "url" }
  ]
}
```

Up to eight steps run in order; a failure stops the steps after it. CLI paths are relative to
the workflow file, MCP paths are absolute.
