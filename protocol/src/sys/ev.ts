/**
 * Events (syscall-abi.md §4.4.9). A subscription is a handle in the process's fd table; closing the
 * fd or ending the process drops it. Views do not call `sys.events`: their subscriptions are pushed
 * to the view port as `{t:'events'}`, at most one batch per frame.
 */
import * as v from 'valibot';

import { KEvent, TopicPattern } from '../events.ts';
import { EVENTS_READ_MAX, SUBSCRIBE_TOPICS_MAX } from '../limits.ts';
import { Count, Fd, Path } from './common.ts';

export const SysSubscribeArgs = v.strictObject({
  topics: v.pipe(v.array(TopicPattern), v.minLength(1), v.maxLength(SUBSCRIBE_TOPICS_MAX)),
  /** Scope `vfs.*` events to a subtree: x on it and its ancestors. */
  path: v.optional(Path),
});
export const SysSubscribeRet = v.strictObject({ fd: Fd });

export const SysEventsArgs = v.strictObject({
  fd: Fd,
  max: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(EVENTS_READ_MAX))),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2_147_483_647))),
});
export const SysEventsRet = v.strictObject({
  events: v.pipe(v.array(KEvent), v.maxLength(EVENTS_READ_MAX)),
  /** Events dropped from this subscription's queue since the last read (§3.8 rule 4). */
  dropped: Count,
});
