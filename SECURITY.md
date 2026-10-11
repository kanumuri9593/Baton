# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or discussion.

Use GitHub's private vulnerability reporting:
[github.com/kanumuri9593/Baton/security/advisories/new](https://github.com/kanumuri9593/Baton/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**).

Include the Baton version (`npm ls -g baton-run`), your OS and Node version, what
an attacker can do, and the steps to reproduce. You should get a first reply within a week. A
fix ships in a patch release, and the advisory is published once that release is out.

## Supported versions

Only the latest published release of `baton-run` gets security fixes.

## How Baton is exposed

Baton starts real processes on your machine, so its boundary is worth knowing:

- The daemon listens on `127.0.0.1` only. It never binds a public interface.
- Every client authenticates with a random token stored in `~/.baton/daemon.json`, written with
  file mode `0600` so only your user can read it.
- `baton-mcp` speaks MCP over stdio to the client that started it. It has no network listener
  of its own.
- Baton runs the targets defined in your project's launch files and `package.json`. Treat a
  repository's launch configuration like any other code you choose to run.
- `baton doctor --json` and `inspect_project` leave environment values out of their reports.

Things that would be a vulnerability: a way to reach the daemon from another machine or another
local user, to run commands without the token, or to read the token without access to the
user's home directory. Do not expose the daemon port (for example through a tunnel or port
forward), and do not commit secrets in launch files.
