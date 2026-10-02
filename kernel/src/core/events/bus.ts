/**
 * The kernel event bus (syscall-abi.md §3.8 and §4.6, ABI-07; INV-ABI-5).
 *
 * - Publishers call `publish` only after the state change is committed (VFS after `oncomplete`).
 * - Every topic has its own strictly increasing `seq`; delivery is in-memory, at most once, FIFO per
 *   topic per subscriber.
 * - Permission filter at publish time: topics that expose file-system or session state are routed
 *   through a visibility hook the owning subsystem installs (the VFS for `vfs.*` and `lock.*`).
 *   Until a hook claims such a topic it is delivered to root only, so nothing leaks by default.
 * - A subscription holds at most 1,024 undelivered events: on overflow the oldest are dropped, the
 *   next read reports `dropped`, and the subscriber alone receives `bus.overflow`.
 */
import type { EventData, KEvent, Topic } from '@plotinium/protocol';
import { topicMatches } from '@plotinium/protocol';

export const SUBSCRIPTION_QUEUE_MAX = 1_024;

export interface SubscriberCred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
}

/**
 * Decides whether `cred` may see `event`. Return `undefined` to fall back to the default rule of
 * §4.6 for that topic.
 */
export type VisibilityHook = (cred: SubscriberCred, event: KEvent) => boolean | undefined;

/** Topic groups whose §4.6 filter needs another subsystem's state (VFS permissions, sessions). */
const GUARDED_GROUPS = new Set(['vfs', 'lock', 'wm', 'notify']);

function defaultVisible(cred: SubscriberCred, event: KEvent): boolean {
  if (event.topic === 'ai.predict') return event.data.uid === cred.uid;
  const group = event.topic.split('.')[0] ?? event.topic;
  if (GUARDED_GROUPS.has(group)) return cred.uid === 0;
  return true;
}

export interface SubscribeOptions {
  readonly cred: SubscriberCred;
  /** Queue limit; defaults to 1,024 (tests use smaller values). */
  readonly limit?: number;
  /** Called when the queue goes from empty to non-empty (wakes `sys.events` or a view batch). */
  readonly onReady?: (sub: Subscription) => void;
}

export class Subscription {
  readonly id: number;
  readonly patterns: readonly string[];
  readonly cred: SubscriberCred;
  private readonly limit: number;
  private readonly onReady: ((sub: Subscription) => void) | undefined;
  private queue: KEvent[] = [];
  private droppedSinceRead = 0;
  private overflowNotified = false;
  private isClosed = false;

  constructor(id: number, patterns: readonly string[], opts: SubscribeOptions) {
    this.id = id;
    this.patterns = [...patterns];
    this.cred = opts.cred;
    this.limit = opts.limit ?? SUBSCRIPTION_QUEUE_MAX;
    this.onReady = opts.onReady;
  }

  get pending(): number {
    return this.queue.length;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  matches(topic: Topic): boolean {
    return this.patterns.some((p) => topicMatches(p, topic));
  }

  /** Enqueue; returns the topic that overflowed, if this push dropped an event. */
  deliver(event: KEvent): Topic | null {
    if (this.isClosed) return null;
    const wasEmpty = this.queue.length === 0;
    let overflowed: Topic | null = null;
    if (this.queue.length >= this.limit) {
      const oldest = this.queue.shift();
      this.droppedSinceRead++;
      if (oldest && !this.overflowNotified) overflowed = oldest.topic;
    }
    this.queue.push(event);
    if (wasEmpty) this.onReady?.(this);
    return overflowed;
  }

  /** Enqueue the `bus.overflow` notice for this subscriber only (it may replace one more event). */
  notifyOverflow(event: KEvent<'bus.overflow'>): void {
    this.overflowNotified = true;
    if (this.queue.length >= this.limit) {
      this.queue.shift();
      this.droppedSinceRead++;
    }
    this.queue.push(event);
  }

  /** Take up to `max` events, oldest first, and the number dropped since the previous read. */
  take(max = this.limit): { events: KEvent[]; dropped: number } {
    const n = Math.max(0, Math.min(max, this.queue.length));
    const events = this.queue.slice(0, n);
    this.queue = this.queue.slice(n);
    const dropped = this.droppedSinceRead;
    this.droppedSinceRead = 0;
    if (this.queue.length === 0) this.overflowNotified = false;
    return { events, dropped };
  }

  close(): void {
    this.isClosed = true;
    this.queue = [];
  }
}

export class EventBus {
  private readonly seqs = new Map<Topic, number>();
  private readonly subs = new Set<Subscription>();
  private readonly hooks: VisibilityHook[] = [];
  private nextId = 1;
  private readonly epochMs: () => number;

  constructor(epochMs: () => number) {
    this.epochMs = epochMs;
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  /** The seq the next event of `topic` will carry minus one (0 if none was published). */
  lastSeq(topic: Topic): number {
    return this.seqs.get(topic) ?? 0;
  }

  /** Install a visibility hook; later hooks are consulted first. Returns the uninstall function. */
  addVisibilityHook(hook: VisibilityHook): () => void {
    this.hooks.unshift(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  subscribe(patterns: readonly string[], opts: SubscribeOptions): Subscription {
    const sub = new Subscription(this.nextId++, patterns, opts);
    this.subs.add(sub);
    return sub;
  }

  unsubscribe(sub: Subscription): void {
    sub.close();
    this.subs.delete(sub);
  }

  private stamp<T extends Topic>(topic: T, data: EventData[T]): KEvent<T> {
    const seq = (this.seqs.get(topic) ?? 0) + 1;
    this.seqs.set(topic, seq);
    return { topic, seq, t: Math.max(0, Math.floor(this.epochMs())), data };
  }

  private visible(cred: SubscriberCred, event: KEvent): boolean {
    for (const hook of this.hooks) {
      const verdict = hook(cred, event);
      if (verdict !== undefined) return verdict;
    }
    return defaultVisible(cred, event);
  }

  /** Publish after commit. Returns the stamped event. O(S) for S subscribers. */
  publish<T extends Topic>(topic: T, data: EventData[T]): KEvent<T> {
    const stamped = this.stamp(topic, data);
    // KEvent<T> for a generic T is one member of the KEvent union; widen it for delivery.
    const event = stamped as unknown as KEvent;
    for (const sub of this.subs) {
      if (!sub.matches(topic) || !this.visible(sub.cred, event)) continue;
      const overflowed = sub.deliver(event);
      if (overflowed !== null) {
        sub.notifyOverflow(this.stamp('bus.overflow', { topic: overflowed, dropped: 1 }));
      }
    }
    return stamped;
  }
}
