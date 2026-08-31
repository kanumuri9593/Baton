# Checkout worktrees — design

Date: 2026-08-31  
Status: approved

Baton already lets you pick a target (flavor) and a device. This adds a **Checkout** pick so you can run another git ref — or an agent’s existing worktree — without stashing, checking out, or moving the folder VS Code has open.

## Problem

Comparing a feature with and without it today means `git stash` / `git switch` in the editor you are writing in. Two agents on the same feature cannot each own a live sim. Removing a Baton session must not leave orphan copies, and must not delete an agent’s files.

## Decisions (locked)

- Default is **This checkout**: the registered project folder, dirty files included. Zero extra disk.
- Other refs get a git worktree under `~/.baton/worktrees/`, sharing the object database.
- Copy gitignored **config** (secrets, `.env`, flavor define-files) from the source folder. Do **not** copy `build/`, `.dart_tool`, `node_modules`.
- Symlink `.fvm/flutter_sdk` when present so the copy uses the same Flutter SDK.
- Stop keeps the copy (warm re-run). Forget/dismiss deletes **only Baton-owned** copies.
- Picker lists local branches and remotes. Fetch is best-effort in the background.
- Attach existing worktrees of this repo. Never delete those.
- Sessions stay on the original project tab. The process `cwd` is the checkout folder so hot reload follows that agent’s edits.
- Picking `origin/main` never silently attaches the dirty main folder.

## User-facing model

The launcher is: **Target · Checkout · Device · Run**.

Checkout rows:

| Group | Meaning | On Run |
|---|---|---|
| This checkout | The project folder (default) | Start in place |
| Worktrees | Every linked worktree of this repo, labelled branch + folder | Attach that path. Never delete. |
| Local / Remote | `feat/x`, `origin/main`, other remotes | Reuse a Baton-owned copy of that ref if one exists; otherwise create one |

A session row stays under the project you added. When the checkout is not This checkout, the row shows the ref (`origin/main`, `feat/agent-a`). Hot reload applies to **that session’s folder**.

Two agents on one feature: pick each worktree × a device. No branch switch in VS Code.

Not a git repo: the picker is This checkout only. Run is unchanged.

## Create / attach

**This checkout** — `cwd` is the project root. `kind: inplace`.

**Worktree row** — `cwd` is that folder. `kind: attached`. Copy a config file only when it is missing in the worktree; never overwrite an agent’s file.

**Branch row** — look up an owned copy for `(sourceRoot, ref)`. If present, reuse it (`kind: owned`). Otherwise:

1. `git fetch` if the ref is remote (failure is non-fatal only for listing; create still needs the object).
2. `git worktree add --detach <path> <ref>` under `~/.baton/worktrees/<project-slug>/<ref-slug>/`. Detached HEAD so a branch already checked out in This checkout still gets a **clean** copy of that commit.
3. Copy gitignored config from the source folder. Symlink `.fvm/flutter_sdk`.
4. Persist the owned record. `kind: owned`.

`--branch` and `--checkout` are mutually exclusive. Omit both → This checkout. `--checkout /path` attaches that path if it is a worktree of the same repository (same `git-common-dir`); otherwise error.

Targets are detected from the **checkout** `cwd` at Run time, so the other branch’s `launch.json` is what actually runs. Session `root` remains the registered project, so the HUD does not grow a second tab.

Session ids stay project-scoped using the **source** folder’s name. When the checkout is not inplace, the id also includes a slug of the ref so the same target can run from This checkout and from `origin/main` on the same device.

## Cleanup

| Action | Owned copy | Attached worktree |
|---|---|---|
| Stop | Process dies; folder stays | Same |
| Forget / dismiss the session | If no other session still uses that `cwd`, `git worktree remove --force` and drop the record | Session row goes away; files stay |
| Remove project from the HUD | Owned copies for that repo with no live session are removed | Files stay |
| Daemon restart | Owned records persist; next Run of that ref reuses the folder | n/a |

A stopped session still “uses” the copy until it is forgotten, so two stopped rows on the same owned ref do not delete the folder when the first is dismissed.

Forget while still running: unchanged (stop first).

After forget, the daemon broadcasts `{ event: 'forgotten', sessionId }` so every HUD drops the row.

## Config copy

Copy from the source folder into the checkout when the destination path is missing (attach) or always-on-create (owned):

- Basenames matching `^\.env`, `\.local\.json$`, `^secrets`, `google-services.json`, `GoogleService-Info.plist`
- Paths named by `--dart-define-from-file` in the source `launch.json`
- Do not descend into `build`, `.dart_tool`, `node_modules`, `.git`, `Pods`, `.gradle`, `DerivedData`

If a required define-file is still missing after copy, existing preflight fires.

## Errors

| What happened | What you see |
|---|---|
| Not a git repo | This checkout only |
| `git fetch` fails | Locals + last-known remotes; toast; Run of a local ref still works |
| `git worktree add` fails | Run aborts with git’s message; current checkout unchanged |
| Attached folder is gone | Start fails; picker drops it on refresh. Baton does not recreate agent worktrees |
| `--branch` and `--checkout` together | Error: pick one |
| `--checkout` is not a worktree of this repo | Error |
| Secret still missing | Same preflight as today |

## Surfaces

**HUD** — `select#checkout` beside Device. Default This checkout. Session meta shows the ref when not inplace. Stopped/failed rows get a dismiss control that calls `forget`. Removing a project also deletes that project’s idle owned copies; the tab tooltip must say so.

**CLI**

```
baton run "iOS Simulator (DEV)" --branch origin/main
baton run "iOS Simulator (DEV)" --checkout ~/wt/agent-a
baton checkouts                 # This checkout, worktrees, local, remotes
```

`baton forget` on an owned session still deletes the copy when it is the last user.

**MCP** — `run_target` gains optional `branch` and `checkout`. New `list_checkouts`.

## Data

`SessionSnapshot.checkout?: { kind: 'inplace' | 'attached' | 'owned'; ref?: string; cwd: string }`  
Omitted when inplace so existing clients stay quiet.

Owned records: `~/.baton/checkouts.json` — `{ sourceRoot, cwd, ref }[]`.

RPC: `checkouts { cwd?, fetch? } → CheckoutListEntry[]`. `run` gains `branch?` and `checkout?`.

```ts
type CheckoutListEntry = {
  id: string;          // 'inplace' | 'worktree:<path>' | 'ref:<name>'
  kind: 'inplace' | 'worktree' | 'ref';
  label: string;
  group: 'this' | 'worktrees' | 'local' | 'remote';
  ref?: string;
  cwd?: string;        // inplace and worktree
};
```

## Tests (no simulator)

Real git in temp dirs. Fake nothing about worktrees.

- List: This checkout + local branch + existing worktree; non-git → inplace only
- Create owned copy of another branch; source HEAD unchanged; secrets copied; `build/` not copied
- Reuse owned copy for the same `(sourceRoot, ref)`
- Branch already checked out in source still creates a detached copy
- Attach existing worktree; forget does not delete it
- Forget last owned session removes the worktree; a second session on the same cwd keeps it
- Run with `--branch` sets `snapshot.root` to the project and `snapshot.checkout.cwd` to the worktree
- `--branch` and `--checkout` together fail

## Out of scope

- Opening the copy in VS Code
- Showing owned copies as extra project tabs
- Free-text SHA / PR ref picker
- Copying build caches
- Deleting agent worktrees
