---
name: doctor
description: Check that Baton can run on this machine and in this project, and explain how to fix what is missing.
disable-model-invocation: true
---

Check the Baton setup and report what works and what to fix, in plain words.

1. Run `node --version`. Baton needs Node.js 24 or newer. If it is older, say so and stop;
   suggest the user's version manager (`nvm install 24`, `fnm install 24`, or the
   installer from nodejs.org).
2. Check whether the `baton` MCP tools are available. If they are, call `inspect_project`
   with `cwd` set to the absolute project path and summarise its blockers and guidance.
3. If the tools are not available, run
   `npx -y --package=baton-run@0.2.8 baton doctor` in the shell and summarise the output.
   Then tell the user to run `/mcp` to see the server's error, or restart Claude Code after
   fixing Node.
4. For mobile work: note whether Flutter, Xcode (`xcrun simctl`), or the Android SDK
   (`adb`) are on the PATH, but only for the frameworks this project uses.
5. End with a short list: what is ready, what is missing, and the one command to fix each.
