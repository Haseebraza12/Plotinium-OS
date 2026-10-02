/**
 * The `update` service's port (boot-and-services.md §3.3; offline-and-sync.md OFF-05): the router
 * registers the Service Worker (vite-plugin-pwa `injectManifest`, web/src/sw.ts) after
 * desktop-interactive and forwards its events; a waiting worker is a new version, announced to
 * the desktop as `update.available`.
 */
import type { SwEvent, UpdatePort } from '@plotinium/services';

export interface UpdateIoDeps {
  readonly supported: boolean;
  readonly requestRegister: (() => void) | undefined;
  /** A waiting worker: the desktop shows "Restart to update". */
  readonly waiting: () => void;
}

export class UpdateIo implements UpdatePort {
  private readonly deps: UpdateIoDeps;
  private readonly cbs = new Set<(e: SwEvent) => void>();
  private last: SwEvent | null = null;

  constructor(deps: UpdateIoDeps) {
    this.deps = deps;
  }

  get lastEvent(): SwEvent | null {
    return this.last;
  }

  register(): void {
    if (this.deps.requestRegister === undefined) {
      // No router can register one (the loopback host, tests): report it as an error at once.
      queueMicrotask(() => {
        this.event('error');
      });
      return;
    }
    this.deps.requestRegister();
  }

  onEvent(cb: (e: SwEvent) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  supported(): boolean {
    return this.deps.supported;
  }

  /** The router's Service Worker event. */
  event(e: SwEvent): void {
    this.last = e;
    if (e === 'waiting') this.deps.waiting();
    for (const cb of [...this.cbs]) cb(e);
  }
}
