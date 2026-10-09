---
name: run
description: Run an app target with Baton, wait until it is ready, and report the URL, device, and any errors.
argument-hint: "[target name] [--branch <ref>]"
disable-model-invocation: true
---

Run an app in this project with Baton. Arguments from the user: `$ARGUMENTS`

1. Call `inspect_project` and `list_targets` with `cwd` set to the absolute path of the
   current project.
2. Pick the target that matches the arguments (any unambiguous substring). If there are no
   arguments and more than one sensible target, list them in one short message and ask
   which one; if there is only one, use it.
3. If a session for that target is already running (`list_sessions`), report it instead of
   starting a second copy.
4. Call `run_target` (pass `branch` if the user gave `--branch`), then `wait_for` the
   session until `running` (or `url` for web targets).
5. Reply with: session id, status, URL or device, and the first real error from
   `session_summary` or `read_logs` if it failed. For simulators, attach a `screenshot`.
