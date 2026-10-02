import { describe, expect, it } from 'vitest';

import type { KEvent } from '@plotinium/protocol';

import { FrameBatcher } from '../src/core/events/batch.ts';
import { EventBus, SUBSCRIPTION_QUEUE_MAX } from '../src/core/events/bus.ts';

const alice = { uid: 1001, gid: 1001, groups: [] };
const root = { uid: 0, gid: 0, groups: [] };
const spawnData = {
  pid: 2,
  ppid: 1,
  pgid: 2,
  uid: 1001,
  argv0: 'sh',
  priority: 20,
  class: 'user' as const,
};

describe('event bus', () => {
  it('ABI-07 each topic has its own strictly increasing seq and events carry an epoch timestamp', () => {
    const bus = new EventBus(() => 1_700_000_000_000.7);
    const a = bus.publish('proc.spawn', spawnData);
    const b = bus.publish('proc.spawn', spawnData);
    const c = bus.publish('proc.state', { pid: 2, from: 'NEW', to: 'READY', reason: 'admit' });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
    expect(a.t).toBe(1_700_000_000_000);
    expect(bus.lastSeq('proc.spawn')).toBe(2);
    expect(bus.lastSeq('vfs.write')).toBe(0);
  });

  it('ABI-07 subscriptions match exact topics and group patterns, FIFO per subscriber', () => {
    const bus = new EventBus(() => 0);
    const exact = bus.subscribe(['proc.exit'], { cred: alice });
    const group = bus.subscribe(['proc.*'], { cred: alice });
    bus.publish('proc.spawn', spawnData);
    bus.publish('proc.exit', { pid: 2, status: { kind: 'exited', code: 0 }, reason: 'normal' });
    expect(exact.take().events.map((e) => e.topic)).toEqual(['proc.exit']);
    expect(group.take(1).events.map((e) => e.topic)).toEqual(['proc.spawn']);
    expect(group.pending).toBe(1);
    expect(group.take().events.map((e) => e.topic)).toEqual(['proc.exit']);
    expect(bus.subscriberCount).toBe(2);
    bus.unsubscribe(exact);
    expect(exact.closed).toBe(true);
    expect(bus.subscriberCount).toBe(1);
  });

  it('ABI-07 a vfs.write event is not delivered to another uid unless the VFS filter allows it', () => {
    const bus = new EventBus(() => 0);
    const subA = bus.subscribe(['vfs.*'], { cred: alice });
    const subRoot = bus.subscribe(['vfs.*'], { cred: root });
    const write = {
      ino: '00000000-0000-7000-8000-000000000001',
      parent: '00000000-0000-7000-8000-000000000001',
      version: 1,
      size: 1,
      origin: 'local' as const,
    };
    bus.publish('vfs.write', write);
    expect(subA.pending).toBe(0);
    expect(subRoot.pending).toBe(1);
    const off = bus.addVisibilityHook((cred, ev) =>
      ev.topic === 'vfs.write' ? cred.uid === 1001 : undefined,
    );
    bus.publish('vfs.write', write);
    expect(subA.pending).toBe(1);
    expect(subRoot.pending).toBe(1);
    off();
    bus.publish('vfs.write', write);
    expect(subA.pending).toBe(1);
  });

  it('ABI-07 ai.predict events go to processes of the same uid only', () => {
    const bus = new EventBus(() => 0);
    const subA = bus.subscribe(['ai.predict'], { cred: alice });
    const subB = bus.subscribe(['ai.predict'], { cred: { uid: 1002, gid: 1002, groups: [] } });
    bus.publish('ai.predict', { uid: 1001, predictions: [] });
    expect([subA.pending, subB.pending]).toEqual([1, 0]);
  });

  it('ABI-07 on overflow the oldest are dropped, the next read reports dropped and the subscriber alone gets bus.overflow', () => {
    const bus = new EventBus(() => 0);
    const small = bus.subscribe(['proc.*'], { cred: alice, limit: 3 });
    const other = bus.subscribe(['bus.overflow'], { cred: alice });
    for (let i = 0; i < 5; i++) bus.publish('proc.spawn', { ...spawnData, pid: 10 + i });
    const got = small.take();
    expect(got.dropped).toBeGreaterThanOrEqual(2);
    const topics = got.events.map((e) => e.topic);
    expect(topics).toContain('bus.overflow');
    expect(topics.at(-1)).toBe('proc.spawn');
    const last = got.events.at(-1) as KEvent<'proc.spawn'>;
    expect(last.data.pid).toBe(14);
    expect(other.pending).toBe(0);
    expect(SUBSCRIPTION_QUEUE_MAX).toBe(1_024);
    expect(small.take().dropped).toBe(0);
  });

  it('ABI-07 onReady fires when a queue goes from empty to non-empty and a closed subscription takes nothing', () => {
    const bus = new EventBus(() => 0);
    let ready = 0;
    const sub = bus.subscribe(['proc.*'], {
      cred: alice,
      onReady: () => {
        ready++;
      },
    });
    bus.publish('proc.spawn', spawnData);
    bus.publish('proc.spawn', spawnData);
    expect(ready).toBe(1);
    sub.take();
    bus.publish('proc.spawn', spawnData);
    expect(ready).toBe(2);
    sub.close();
    expect(sub.deliver({ topic: 'proc.spawn', seq: 9, t: 0, data: spawnData })).toBeNull();
    expect(sub.pending).toBe(0);
  });
});

describe('frame batcher', () => {
  it('ABI-07 a view subscriber receives at most one event batch per animation frame', () => {
    const frames: (() => void)[] = [];
    const batches: number[][] = [];
    const b = new FrameBatcher<number>(
      (cb) => frames.push(cb),
      (batch) => batches.push(batch),
    );
    b.push(1);
    b.push(2);
    b.push(3);
    expect(frames).toHaveLength(1);
    expect(b.pending).toBe(3);
    frames.shift()?.();
    expect(batches).toEqual([[1, 2, 3]]);
    b.push(4);
    expect(frames).toHaveLength(1);
    b.flush();
    b.flush();
    expect(batches).toEqual([[1, 2, 3], [4]]);
  });
});
