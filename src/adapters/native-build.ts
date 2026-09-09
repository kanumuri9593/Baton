import { ProcessSession, type ProcessSessionOptions } from './process.ts';
import { sessionId } from '../core/session-base.ts';
import type { Capability } from '../core/types.ts';

const CAPABILITIES: readonly Capability[] = ['restartProcess', 'stop'];

/**
 * An incremental Xcode or Gradle build/install supervised by Baton.
 *
 * Native toolchains do not expose a portable state-preserving hot-reload
 * channel. Keeping them as their own kinds makes that limitation visible while
 * still offering logs, stop, and an incremental rebuild via process restart.
 */
export class NativeBuildSession extends ProcessSession {
  readonly kind: 'ios' | 'android';

  constructor(kind: 'ios' | 'android', id: string, name: string, options: ProcessSessionOptions) {
    super(id, name, options, CAPABILITIES);
    this.kind = kind;
  }

  static create(kind: 'ios' | 'android', name: string, options: ProcessSessionOptions): NativeBuildSession {
    return new NativeBuildSession(
      kind,
      sessionId(options.idRoot ?? options.cwd, name, options.checkoutSlug),
      name,
      options,
    );
  }
}
