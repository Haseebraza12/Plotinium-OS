/**
 * The planner's transcript store (agentic-shell.md §3.8.1): in memory, keyed by the agent's
 * requestId, bound to the uid that started it, TTL 10 minutes since the last turn, at most 1,000
 * entries (dsa/lru evicts the least recently used). A request after expiry, restart or eviction is
 * 409 EAIUNAVAIL `expired` ("conversation expired — please retry").
 *
 * The transcript is STRICTLY APPEND-ONLY: every assistant `content` array is kept unchanged
 * (thinking blocks included) and nothing earlier is ever rebuilt, because the model ties its
 * thinking to the exact prefix. A turn's user message is appended only together with the model's
 * reply, so a failed turn leaves the transcript as it was and the client can retry that turn.
 */
import { LruCache } from '@plotinium/dsa/lru';

import type { BetaMessageParam } from '../engine/llm/anthropic.ts';

export const TRANSCRIPT_TTL_MS = 10 * 60_000;
export const TRANSCRIPT_MAX = 1_000;

export interface Transcript {
  readonly uid: number;
  /** The last completed turn (1..6). */
  readonly turn: number;
  readonly messages: readonly BetaMessageParam[];
  /** The tool_use id the next toolResult must answer, when the last reply was an observation. */
  readonly pendingToolUseId: string | null;
  readonly usedAt: number;
}

export type TranscriptLookup =
  | { readonly ok: true; readonly transcript: Transcript }
  | { readonly ok: false; readonly reason: 'expired' | 'foreign' };

export class TranscriptStore {
  readonly #lru: LruCache<string, Transcript>;
  readonly #busy = new Set<string>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(
    options: { readonly now?: () => number; readonly ttlMs?: number; readonly max?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? TRANSCRIPT_TTL_MS;
    this.#lru = new LruCache<string, Transcript>({ capacity: options.max ?? TRANSCRIPT_MAX });
  }

  get size(): number {
    return this.#lru.size;
  }

  /** The transcript of `requestId` for `uid`; another uid's transcript is never revealed. */
  get(requestId: string, uid: number): TranscriptLookup {
    const t = this.#lru.get(requestId);
    if (t === undefined) return { ok: false, reason: 'expired' };
    if (this.#now() - t.usedAt > this.#ttlMs) {
      this.#lru.delete(requestId);
      return { ok: false, reason: 'expired' };
    }
    if (t.uid !== uid) return { ok: false, reason: 'foreign' };
    return { ok: true, transcript: t };
  }

  /** Stores the transcript after a completed turn (the only way it grows). */
  put(requestId: string, t: Omit<Transcript, 'usedAt'>): void {
    this.#lru.put(requestId, { ...t, usedAt: this.#now() });
  }

  delete(requestId: string): void {
    this.#lru.delete(requestId);
  }

  /** One model call per requestId at a time (a second concurrent turn is refused). */
  begin(requestId: string): boolean {
    if (this.#busy.has(requestId)) return false;
    this.#busy.add(requestId);
    return true;
  }

  end(requestId: string): void {
    this.#busy.delete(requestId);
  }
}
