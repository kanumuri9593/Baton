import { ProcessSession, type ProcessSessionOptions } from './process.ts';
import { slug } from '../core/session-base.ts';
import type { Capability, OperationResult, SessionSnapshot } from '../core/types.ts';
import { UnsupportedCapability } from '../core/types.ts';

/**
 * Patterns that reveal the URL a dev server settled on.
 *
 * Servers pick a different port when the preferred one is taken, so the URL is
 * scraped from output rather than assumed from config -- otherwise the HUD sends
 * you to a port nothing is listening on.
 */
const URL_PATTERNS: RegExp[] = [
  /(?:Local|local):\s+(https?:\/\/[^\s,]+)/i,          // Vite, Nuxt
  /ready\s+-\s+started server on .*?,\s*url:\s*(\S+)/i, // Next.js 12/13
  /-\s*Local:\s+(https?:\/\/\S+)/i,                     // Next.js 14/15
  /Server running at\s+(https?:\/\/\S+)/i,
  /listening on\s+(https?:\/\/\S+)/i,
  /(?:App|Project) running at:?\s*(https?:\/\/\S+)/i,   // Vue CLI, Angular
  /(https?:\/\/localhost:\d+\/?)/i,                     // last-resort catch-all
];

/** Output that means the server is up and serving, not merely spawned. */
const READY_PATTERNS: RegExp[] = [
  /ready in \d+/i, /compiled successfully/i, /ready\s+-/i, /✓\s*Ready/i,
  /Local:\s+https?:\/\//i, /watching for file changes/i, /server running/i,
];

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'restartProcess', 'stop', 'url',
]);

/**
 * A web dev server (Next.js, Vite, Nuxt, Angular, CRA, Remix, Astro...).
 *
 * These have no external reload API: HMR is driven by the file watcher, so an
 * agent editing a file already gets the update without asking. What is genuinely
 * useful here is knowing the URL, knowing when the server is actually ready, and
 * being able to reboot it when config changes. Those are the capabilities claimed.
 */
export class WebDevSession extends ProcessSession {
  readonly kind = 'web-dev';
  readonly capabilities = CAPABILITIES;

  url?: string;
  #ready = false;

  static create(name: string, options: ProcessSessionOptions): WebDevSession {
    return new WebDevSession(slug(name), name, options);
  }

  protected markRunningWhenReady(): void {
    // Stay in `starting` until the server actually reports readiness. A dev
    // server that spawns and then dies on a port conflict should never be
    // reported as running.
    this.setStatus('starting');
  }

  protected handleOutput(text: string, isError: boolean): void {
    super.handleOutput(text, isError);

    if (!this.url) {
      for (const pattern of URL_PATTERNS) {
        const match = text.match(pattern);
        if (match?.[1]) {
          this.url = match[1].replace(/[.,)]+$/, '');
          this.emit('change');
          break;
        }
      }
    }

    if (!this.#ready && READY_PATTERNS.some((p) => p.test(text))) {
      this.#ready = true;
      this.progress = undefined;
      this.setStatus('running');
    }
  }

  hotReload(_reason?: string): Promise<OperationResult> {
    return Promise.reject(
      new UnsupportedCapability(
        this.kind,
        'hotReload',
        'HMR applies file edits automatically; restart reboots the dev server',
      ),
    );
  }

  async hotRestart(reason?: string): Promise<OperationResult> {
    this.url = undefined;
    this.#ready = false;
    return super.hotRestart(reason);
  }

  protected extraSnapshot(): Partial<SessionSnapshot> {
    return { url: this.url, target: this.url };
  }
}
