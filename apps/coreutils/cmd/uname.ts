/**
 * `uname [-a] [-s] [-r] [-v] [-m]` (identity-and-branding.md §3.8, PLT-ID-07): the fields are
 * printed in the order s, r, v, m; `-a` is the full identity line. A usage error makes no syscall.
 */
import type { UnameInfo } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';

export interface UnameOpts {
  readonly all: boolean;
  readonly fields: readonly ('s' | 'r' | 'v' | 'm')[];
}

export function browserText(info: UnameInfo): string {
  const { brand, major } = info.browser;
  return brand === 'Unknown browser' || major === null ? brand : `${brand} ${major}`;
}

export function machineText(info: UnameInfo): string {
  return `${browserText(info)} · ${info.cores} ${info.cores === 1 ? 'core' : 'cores'}`;
}

export function kernelRelease(info: UnameInfo): string {
  return `${info.version}-${info.build}`;
}

export function unameAll(info: UnameInfo): string {
  return `${info.sysname} ${info.version} (kernel ${kernelRelease(info)}, built ${info.buildDate}) · ${machineText(info)} · uid=${info.uid}(${info.user})`;
}

export function unameFields(info: UnameInfo, fields: UnameOpts['fields']): string {
  const text = {
    s: info.sysname,
    r: kernelRelease(info),
    v: `built ${info.buildDate}`,
    m: machineText(info),
  };
  return fields.map((f) => text[f]).join(' ');
}

export default defineCommand<UnameOpts>({
  name: 'uname',
  parse(args) {
    const p = parseFor('uname', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    const fields = (['s', 'r', 'v', 'm'] as const).filter((f) => p.has(f));
    return { all: p.has('a'), fields: fields.length === 0 ? ['s'] : fields };
  },
  *run(io, opts) {
    try {
      const info = yield* io.sys.call('uname', {});
      yield* io.line(opts.all ? unameAll(info) : unameFields(info, opts.fields));
      return 0;
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
  },
});
