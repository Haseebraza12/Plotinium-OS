/**
 * TEST-ONLY harness: a real `Syncd` (and optionally `Lockd`) over a device store, wired to the fake
 * server and the virtual clock, recording every status, notice and effect.
 */
import type { NetStatus } from '@plotinium/protocol';

import { Lockd } from '../../../locks/lockd.ts';
import type { LockEvent, LockManagerLike } from '../../../locks/types.ts';
import type { OutboxRec } from '../../../store/records.ts';
import type { SyncEffect, SyncHttp } from '../../ports.ts';
import { StoreSyncStorage } from '../../storage.ts';
import { Syncd } from '../../syncd.ts';
import type { SyncNotice } from '../../types.ts';
import { FakeClock, settle } from './clock.ts';
import { ALICE, DEVICE, Device, OS_SESSION, baseSeed, tid } from './device.ts';
import type { Seed } from './device.ts';
import { FakeServer } from './fake-server.ts';

/** A seeded linear congruential generator in [0, 1). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface HarnessOpts {
  readonly seed?: Seed;
  readonly online?: boolean;
  readonly clock?: FakeClock;
  readonly server?: FakeServer;
  readonly device?: Device;
  readonly osSessionId?: string;
  readonly loginUid?: number;
  readonly auth?: { uid: number; username: string };
  readonly withLocks?: boolean;
  readonly locks?: LockManagerLike;
  readonly http?: Partial<SyncHttp>;
}

export class Harness {
  readonly clock: FakeClock;
  readonly server: FakeServer;
  readonly dev: Device;
  readonly syncd: Syncd;
  readonly lockd: Lockd | null;
  readonly statuses: { status: NetStatus; label: string }[] = [];
  readonly notices: SyncNotice[] = [];
  readonly effects: SyncEffect[] = [];
  readonly lockEvents: LockEvent[] = [];
  readonly uploads: string[] = [];
  private idSeq = 0;

  private constructor(opts: HarnessOpts, dev: Device) {
    this.clock = opts.clock ?? new FakeClock();
    this.server = opts.server ?? new FakeServer(this.clock);
    this.dev = dev;
    const server = this.server;
    const http: SyncHttp = {
      authMe: () => Promise.resolve(server.authStatus),
      healthz: () => Promise.resolve(server.healthy),
      postOp: (opId, body) => Promise.resolve(server.postOp(opId, body)),
      putBlob: (s) => {
        this.uploads.push(s);
        return Promise.resolve();
      },
      snapshot: (url, after) => Promise.resolve(server.snapshotPage(url, after)),
      ...opts.http,
    };
    this.syncd = new Syncd({
      session: {
        osSessionId: opts.osSessionId ?? OS_SESSION,
        deviceId: DEVICE,
        kernelEpoch: 1,
        loginUid: opts.loginUid ?? ALICE,
        build: { name: 'Plotinium', version: '1.0.0', build: 'abc1234', date: '2027-01-15' },
        url: 'wss://plotinium.test/ws',
      },
      storage: new StoreSyncStorage(dev.store),
      socket: server.factory(opts.auth),
      http,
      clock: this.clock,
      random: seededRandom(11),
      timeZone: 'UTC',
      online: opts.online ?? true,
      host: {
        status: (status, label) => this.statuses.push({ status, label }),
        notice: (n) => this.notices.push(n),
        applied: (e) => this.effects.push(e),
      },
    });
    this.lockd =
      opts.withLocks === true
        ? new Lockd({
            channel: this.syncd,
            clock: this.clock,
            newId: () => tid(0x7e9000 + ++this.idSeq),
            ...(opts.locks === undefined ? {} : { locks: opts.locks }),
            emit: (e) => this.lockEvents.push(e),
          })
        : null;
    if (this.lockd !== null) this.syncd.attachLocks(this.lockd);
  }

  static async create(opts: HarnessOpts = {}): Promise<Harness> {
    let dev = opts.device;
    if (dev === undefined) {
      dev = await Device.open();
      const b = baseSeed();
      const s = opts.seed ?? {};
      await dev.seed({
        inodes: [...(b.inodes ?? []), ...(s.inodes ?? [])],
        dentries: [...(b.dentries ?? []), ...(s.dentries ?? [])],
        users: s.users ?? b.users ?? [],
        blobs: s.blobs ?? [],
        undo: s.undo ?? [],
        outbox: s.outbox ?? [],
        meta: s.meta ?? [],
      });
    }
    const h = new Harness(opts, dev);
    await h.syncd.start();
    return h;
  }

  get label(): string {
    return this.syncd.status().label;
  }

  outbox(): OutboxRec[] {
    return this.dev.dump<OutboxRec>('outbox');
  }

  /** Connect and run until LIVE (or the step budget ends). */
  async live(maxSteps = 50): Promise<void> {
    if (this.syncd.state === 'IDLE') this.syncd.connect();
    await settle();
    for (let i = 0; i < maxSteps && this.syncd.state !== 'LIVE'; i++)
      await this.clock.advance(1_000);
  }

  /** Advance until `done()` holds (or the step budget ends). */
  async until(
    done: () => boolean,
    stepMs = 1_000,
    maxSteps = 400,
    perTimer = 40,
  ): Promise<boolean> {
    for (let i = 0; i < maxSteps; i++) {
      if (done()) return true;
      await this.clock.advance(stepMs, 40, perTimer);
    }
    return done();
  }

  labels(): string[] {
    const out: string[] = [];
    for (const s of this.statuses) if (out[out.length - 1] !== s.label) out.push(s.label);
    return out;
  }
}
