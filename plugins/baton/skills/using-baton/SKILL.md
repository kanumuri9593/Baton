---
name: using-baton
description: Use when the user wants to run, launch, hot-reload, restart, stop, screenshot or debug their app (Flutter, Next.js, Vite, React Native/Expo, native iOS or Android), boot a simulator, run a branch without switching git, or check that a code change actually works on screen. Drives Baton's MCP tools.
---

# Using Baton

Baton is a local run control plane. One background daemon owns every running app, so the
user's terminal, the Baton app (`baton app`), and you all see and press the same buttons.
You reach it through the `baton` MCP server that this plugin starts.

## The loop

1. `inspect_project` with `cwd` set to the absolute project path. Read the blockers and
   guidance before running anything. Always pass `cwd` explicitly: the daemon is shared
   across projects and its own working directory may be elsewhere.
2. `list_targets` (same `cwd`) and pick a target. Names match on any unambiguous substring.
   If the user already has a session running, `list_sessions` first and reuse it.
3. `run_target` (or `run_workflow` for several dependent projects; paths must be absolute).
   Pass `branch` to run another branch from a Baton-owned worktree, or `checkout` to attach
   an existing worktree. Never `git checkout` the user's folder to do this.
4. `wait_for` the returned session (`running`, `url`, or `{ "log": "<regex>" }`) instead of
   polling logs.
5. Check the result: `screenshot` (iOS simulators, Android, and web URLs; pass
   `viewport: "phone"` to see a web app at phone size), `session_summary`, `read_logs`,
   `diagnose`.
6. After every edit: `check_change`. One call applies the change (hot reload for Flutter,
   HMR for web and React Native, restart for the rest) and returns only what is new: the
   reload result, error lines, failed requests and a screenshot. Read `NOT OK` results,
   fix, and call it again. Use `hot_reload` / `hot_restart` directly only when you need
   just that step.
7. Leave sessions running unless the user asks to stop them. `stop_session` stops one;
   `forget_session` removes it from the list.

## Honesty rules

- A screenshot proves an image was captured, not that the UI is right. Look at it and
  say what you see, and say when you could not check something.
- Baton launches and reports evidence. It does not tap the UI or judge the screenshot.
- Respect refusals: a Vite session does not have Flutter hot reload, so do not claim it.
- Do not put secrets in launch files that will be committed. `write_launch_config` edits
  real files the user's IDE also reads; confirm before changing them.

## When the tools are missing or fail

- No `baton` tools at all, or the server fails to start: run `/baton:doctor`.
- Baton needs Node.js 24+. The first call downloads `baton-run` with npx, which can take
  a minute.
- No simulator running: `boot_device` with a name like "iPhone 17 Pro" (call it with no
  name to list what can boot), then `run_target` with the returned `deviceId`.
- Web screenshots need Chrome, Chromium, Edge or Brave on the machine (or `BATON_CHROME`
  pointing at one). Baton does not tap or type: pair it with a browser or device tool
  (Playwright MCP, Chrome DevTools MCP, mobile-mcp) when the flow needs input.
- CLI fallback for anything else: `npx -y --package=baton-run@0.2.9 baton <command>`
  (`doctor --json`, `list`, `run`, `ps`, `logs`, `reload --all`, `devices --all`).
