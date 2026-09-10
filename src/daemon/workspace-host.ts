import { ComposeSession } from '../adapters/compose.ts';
import { pollProbe, type NetProbe } from './probes.ts';
import { waitForSession, type WaitableSession } from './waiter.ts';
import type { SessionRegistry } from '../core/registry.ts';
import type { Session, SessionSnapshot } from '../core/types.ts';
import type { WorkspaceHost } from '../workspace/host.ts';

export type WorkspaceHostDeps = {
  /** The daemon's shared target-start path, so a workspace node runs exactly like `baton run`. */
  runTarget(request: {
    cwd: string; target: string; deviceId?: string; branch?: string; checkout?: string;
    workflow: string; env: Record<string, string>;
    workspace: { id: string; node: string }; ifRunning: 'reuse';
  }): Promise<Session>;
  registry: SessionRegistry;
  /** Recent error lines for a session, attached when readiness fails. */
  recentErrors(session: WaitableSession): string[];
};

/**
 * The engine's side effects, wired to the real daemon.
 *
 * Kept apart from both the engine and the server: the engine should not know
 * about the registry, and the server should not grow another 150 lines. This is
 * the only place the two meet.
 */
export function createWorkspaceHost(deps: WorkspaceHostDeps): WorkspaceHost {
  const snapshotOf = (session: Session): SessionSnapshot => session.snapshot();

  return {
    async runTarget(request) {
      const session = await deps.runTarget({
        cwd: request.cwd,
        target: request.name,
        deviceId: request.device,
        branch: request.branch,
        checkout: request.checkout,
        workflow: request.workflow,
        env: request.env,
        workspace: request.workspace,
        // A node already running is the workspace finding its own work done,
        // not a collision worth failing over.
        ifRunning: 'reuse',
      });
      return snapshotOf(session);
    },

    async runCompose(request) {
      const session = ComposeSession.forService({
        file: request.file,
        service: request.service,
        idRoot: request.root,
      });
      const owned = deps.registry.own(session, {
        projectRoot: request.root,
        workflow: request.workflow,
        workspace: request.workspace,
        ifRunning: 'reuse',
      });
      const running = owned as ComposeSession;
      if (owned === session) {
        session.start();
        // `up -d` and the "is it already running?" check both happen inside
        // start(); waiting for the session to settle is what makes `external`
        // a fact rather than a guess by the time the engine records it.
        await waitForSession(session as WaitableSession, 'running', request.timeoutMs, deps.recentErrors);
      }
      return { session: snapshotOf(owned), external: running.external === true };
    },

    async waitFor(sessionId, until, timeoutMs) {
      const session = deps.registry.get(sessionId);
      if (!session) throw new Error(`session ${sessionId} is gone`);
      const result = await waitForSession(
        session as WaitableSession, until, timeoutMs, deps.recentErrors,
      );
      return { url: result.url ?? session.snapshot().url };
    },

    async probe(probe: NetProbe, timeoutMs: number) {
      await pollProbe(probe, { timeoutMs });
    },

    async stop(sessionId) {
      const session = deps.registry.get(sessionId);
      if (!session) return; // already gone is the state we wanted
      await session.stop();
    },
  };
}
