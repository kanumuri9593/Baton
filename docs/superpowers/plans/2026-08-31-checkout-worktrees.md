# Checkout worktrees — implementation plan

> **For agentic workers:** Execute inline in this session (user asked to execute). Use TDD: failing test, then code. Tests use real git in temp dirs.

**Goal:** Pick a git checkout (this folder, an existing worktree, or a branch/remote) when running a target, without moving the user's current branch; delete Baton-owned copies on forget.

**Architecture:** A `CheckoutStore` resolves a pick to a `{ kind, cwd, sourceRoot, ref }` using `git worktree`. The daemon's `run` detects targets from that cwd, groups the session under `sourceRoot`, and `forget` / `removeProject` call `store.release`. HUD/CLI/MCP are thin clients of `checkouts` + `run`.

**Tech Stack:** Node 24 TypeScript, real git, existing daemon RPC, HUD vanilla JS.

## Global Constraints

- Node 24+, erasable TypeScript only (no `enum` / `namespace`).
- Tests must not require a simulator, device, or network.
- `session.root` is the registered project; process cwd is the checkout.
- Owned copies live under `$BATON_HOME/worktrees/`.
- Never delete an attached worktree.
- `--branch` and `--checkout` are mutually exclusive.
- Exhaustive `switch` with `never` default on `CheckoutKind`.

## File map

- Create: `src/core/checkouts.ts` — list, resolve, copy config, persist, release
- Create: `test/checkouts.test.ts` — real git fixtures
- Modify: `src/core/paths.ts` — `worktreesDir()`, checkout store path
- Modify: `src/core/types.ts` — `CheckoutKind`, `SessionSnapshot.checkout`
- Modify: `src/core/session-base.ts` — `checkout` field on snapshot
- Modify: `src/core/registry.ts` — `RunOptions.projectRoot`, `RunOptions.checkout`, session id suffix
- Modify: adapters (`flutter.ts`, `process.ts`, `web-dev.ts`, `react-native.ts`) — `idRoot` for session id
- Modify: `src/core/api.ts` — `checkouts` RPC, `run.branch` / `run.checkout`, `forgotten` push
- Modify: `src/daemon/server.ts` — wire list/resolve/release
- Modify: `src/cli/index.ts` — `--branch`, `--checkout`, `baton checkouts`
- Modify: `src/mcp/index.ts` — `list_checkouts`, `run_target` fields
- Modify: HUD `index.html`, `core.js`, `hud.css`
- Modify: `test/hud.test.ts`, `test/session-id.test.ts`, `test/server.test.ts`
- Modify: `README.md` — one short subsection

---

### Task 1: CheckoutStore (list / create / attach / copy / release)

**Files:** create `src/core/checkouts.ts`, `test/checkouts.test.ts`; modify `src/core/paths.ts`

**Produces:**

```ts
export type CheckoutKind = 'inplace' | 'attached' | 'owned';
export type Checkout = { kind: CheckoutKind; sourceRoot: string; cwd: string; ref?: string; label: string };
export type CheckoutListEntry = {
  id: string; kind: 'inplace' | 'worktree' | 'ref';
  label: string; group: 'this' | 'worktrees' | 'local' | 'remote';
  ref?: string; cwd?: string;
};
export class CheckoutStore {
  list(sourceRoot: string, opts?: { fetch?: boolean }): CheckoutListEntry[];
  resolve(sourceRoot: string, pick?: { branch?: string; checkout?: string }): Checkout;
  release(checkout: Checkout, stillUsed: boolean): boolean;
  releaseIdleOwned(sourceRoot: string, usedCwds: ReadonlySet<string>): string[];
}
```

`release` returns whether a worktree was removed. `stillUsed` true → no-op.

- [ ] Write `test/checkouts.test.ts` covering: non-git inplace only; list local + worktree; create owned leaves HEAD; secrets copied not `build/`; reuse owned; detached when branch checked out; attach forget is a no-op; last forget removes worktree.
- [ ] Implement `CheckoutStore` until those pass.

---

### Task 2: Session snapshot + registry ids

**Files:** `src/core/types.ts`, `session-base.ts`, `registry.ts`, adapters, `test/session-id.test.ts`

- [ ] Test: same target + device from two checkouts get different ids; `snapshot.root` is source; `snapshot.checkout.cwd` is the worktree.
- [ ] Add `checkout?` on snapshot; `idRoot` + checkout slug on session id; `RunOptions.projectRoot` / `checkout`.

---

### Task 3: Daemon RPC

**Files:** `src/core/api.ts`, `src/daemon/server.ts`, `test/server.test.ts` (or extend checkouts tests via `handle`)

- [ ] Test: `run` with `branch` does not move source HEAD; forget last owned session deletes the worktree; branch+checkout together errors; `forgotten` is broadcast.
- [ ] Wire `checkouts`, extend `run` / `forget` / `removeProject`.

---

### Task 4: CLI + MCP

**Files:** `src/cli/index.ts`, `src/mcp/index.ts`

- [ ] `--branch`, `--checkout`, `baton checkouts`. MCP `list_checkouts` and `run_target` fields.

---

### Task 5: HUD

**Files:** `index.html`, `core.js`, `hud.css`, `test/hud.test.ts`

- [ ] Checkout select; pass `branch` / `checkout` on Run; show ref on the row; dismiss calls `forget`; handle `forgotten`; project-remove tooltip mentions owned copies.

---

### Task 6: README + verify

- [ ] Short README subsection. `npm test` and `npm run typecheck` both pass.
