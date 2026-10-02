/**
 * Syscall handler registry. A call is reachable only if it is in the protocol registry for the
 * port's origin AND a handler is registered in this kernel build; anything else answers ENOSYS
 * at stage 2 (syscall-abi.md §3.3). Subsystems (VFS, sched, mm, tty, ai) register their calls as
 * they land.
 */
import type { ArgsOf, CallName, RetOf } from '@plotinium/protocol';

import type { KernelError } from '../errors.ts';
import type { Caller } from './ports.ts';

/** A handler may return this to send no reply at all (`exit`). */
export const NO_REPLY: unique symbol = Symbol('plotinium.noReply');
export type NoReply = typeof NO_REPLY;

export interface CallImpl<C extends CallName> {
  /** Stage 5: path resolution and rwx for `caller`; null when allowed. */
  authorize?(caller: Caller, args: ArgsOf<C>): KernelError | null;
  /** Stage 7. May be asynchronous for T, B, X and R calls. Throw `KernelError` to fail. */
  handle(caller: Caller, args: ArgsOf<C>): RetOf<C> | NoReply | Promise<RetOf<C> | NoReply>;
  /** For registry audit level 'conditional': whether this invocation is security-relevant. */
  securityRelevant?(caller: Caller, args: ArgsOf<C>): boolean;
}

/** The type-erased form stored in the registry; args were parsed by that call's schema. */
export interface ErasedImpl {
  authorize?(caller: Caller, args: unknown): KernelError | null;
  handle(caller: Caller, args: unknown): unknown;
  securityRelevant?(caller: Caller, args: unknown): boolean;
}

export class HandlerRegistry {
  private readonly impls = new Map<CallName, ErasedImpl>();

  register<C extends CallName>(name: C, impl: CallImpl<C>): void {
    // Sound: the dispatcher only passes args that `CALLS[name].args` has parsed.
    this.impls.set(name, impl);
  }

  get(name: CallName): ErasedImpl | undefined {
    return this.impls.get(name);
  }

  has(name: CallName): boolean {
    return this.impls.has(name);
  }

  names(): CallName[] {
    return [...this.impls.keys()];
  }
}
