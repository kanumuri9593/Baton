# Contributing

Thanks for looking. This project exists because a dev toolbar shouldn't require an IDE.

## Getting started

```bash
npm install
npm test
npm run typecheck
```

Node 24+ is required. Development tests run the TypeScript sources directly,
while the npm package ships compiled JavaScript from `dist/`. Run `npm run build`
before testing package behavior. Only *erasable* TypeScript syntax is allowed in
source: no `enum`, no `namespace`, and no constructor parameter properties.
`npm run typecheck` enforces this.

## Adding a framework adapter

This is the most useful contribution. An adapter teaches Baton to control one kind of dev process.

1. Extend `BaseSession` (or `ProcessSession` if it's process-shaped) in `src/adapters/`.
2. Declare only the capabilities you genuinely implement. **Do not claim `hotReload` unless state is actually preserved** — an honest `UnsupportedCapability` is far more useful than a silent no-op, both to the HUD and to an agent.
3. Teach `src/config/detect.ts` how to recognise the project.
4. Add tests. Prefer replaying a recorded transcript from the real tool over hand-written fixtures; see `test/fixtures/` for the pattern.

Adapters people have asked for: Expo, Storybook, Tauri, Electron, Rails, Django, Phoenix, `dotnet watch`, Go with Air.

## Testing philosophy

Tests must not require a simulator, a device, or a network. Everything is driven through injected seams:

- `FlutterSession` takes a `spawn` override and exposes `ingest()` so a transcript can be replayed
- `DeviceRegistry.ingest()` accepts raw daemon output
- `resolveFlutter()` takes an options object

When you fix a bug, capture the real output that revealed it and add it as a fixture. Two bugs found during initial development — `device.getDevices` hanging forever, and iOS configs silently resolving to a macOS build — are now permanent tests.

## Cross-platform

CI runs on Linux, macOS and Windows. Watch for:

- Process termination — Windows has no signals; `ProcessSession` uses `taskkill`
- Dev servers on Windows are usually `.cmd` shims and need `shell: true`
- Never hard-code `/` in a path; use `node:path`

## Pull requests

Keep them focused. Explain what you observed, not just what you changed — especially for protocol behaviour, where the reasoning matters more than the diff.
