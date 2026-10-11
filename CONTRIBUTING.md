# Contributing

Thanks for looking. This project exists because a dev toolbar shouldn't require an IDE.

## Getting started

```bash
git clone https://github.com/kanumuri9593/Baton.git
cd Baton
npm install
npm test            # portable tests, no simulator, device or network needed
npm run typecheck
```

Node 24+ is required. Development runs the TypeScript sources directly
(`node src/cli/index.ts <command>`, `npm run daemon`, `npm run app`), while the npm package
ships compiled JavaScript from `dist/`. Run `npm run build` before testing package behaviour.
Only *erasable* TypeScript syntax is allowed in source: no `enum`, no `namespace`, and no
constructor parameter properties. `npm run typecheck` enforces this.

## Before you open a pull request

```bash
npm test
npm run typecheck
node scripts/check-plugin-version.mjs   # plugin, docs and server.json pins match package.json
```

If you touched `plugins/baton/` and have the Claude Code CLI installed, also run what CI runs:

```bash
claude plugin validate --strict ./plugins/baton
claude plugin test ./plugins/baton      # the band and /baton pane (hooks/register.tsx)
```

Without a global `claude`, prefix each with `npx -y @anthropic-ai/claude-code`. Add a line
under the top version in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

## Adding a framework adapter

This is the most useful contribution. An adapter teaches Baton to control one kind of dev process.

1. Extend `BaseSession` (or `ProcessSession` if it's process-shaped) in `src/adapters/`.
2. Declare only the capabilities you genuinely implement. **Do not claim `hotReload` unless state is actually preserved.** An honest `UnsupportedCapability` is far more useful than a silent no-op, both to the control panel and to an agent.
3. Teach `src/config/detect.ts` how to recognise the project.
4. Add tests. Prefer replaying a recorded transcript from the real tool over hand-written fixtures; see `test/fixtures/` for the pattern.

Adapters people have asked for: Expo, Storybook, Tauri, Electron, Rails, Django, Phoenix, `dotnet watch`, Go with Air.

## Testing philosophy

Tests must not require a simulator, a device, or a network. Everything is driven through injected seams:

- `FlutterSession` takes a `spawn` override and exposes `ingest()` so a transcript can be replayed
- `DeviceRegistry.ingest()` accepts raw daemon output
- `resolveFlutter()` takes an options object

When you fix a bug, capture the real output that revealed it and add it as a fixture. Two bugs found during initial development, `device.getDevices` hanging forever and iOS configs silently resolving to a macOS build, are now permanent tests.

## Cross-platform

CI runs on Linux, macOS and Windows, on Node 24 and 25. Watch for:

- Process termination: Windows has no signals; `ProcessSession` uses `taskkill`
- Dev servers on Windows are usually `.cmd` shims and need `shell: true`
- Never hard-code `/` in a path; use `node:path`

## Pull requests

Keep them focused. Explain what you observed, not just what you changed, especially for
protocol behaviour, where the reasoning matters more than the diff. The pull request template
asks for Before, After and How you checked it.

## Releases

The npm package and the plugins ship together, so their versions bump together. A release
changes, in one commit:

- `version` in `package.json` and `package-lock.json`
- `version` in `plugins/baton/.claude-plugin/plugin.json` and `plugins/baton/.codex-plugin/plugin.json`
- `version` and `packages[].version` in `server.json`
- every `baton-run@x.y.z` pin in `plugins/baton/.mcp.json`, the plugin skills, `docs/clients.md` and `docs/clients/`
- the `#vx.y.z` install pins in `README.md`, `AGENTS.md` and `llms.txt`
- a dated entry at the top of `CHANGELOG.md`

`node scripts/check-plugin-version.mjs` fails if the plugins, skills, `docs/clients.md` or
`server.json` drift from `package.json`. CI runs it on every push.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), not in an issue.
