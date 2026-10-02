/**
 * The coreutils program table: one program per `/bin/<name>.json` manifest (shell-and-terminal.md
 * §3.14). Every entry has a man page in ./man, whose front matter is its only source of flags
 * (SHL-12); the `satisfies` clause makes a page without a program, or a program without a page, a
 * type error.
 */
import ai from './cmd/ai.ts';
import bootlog from './cmd/bootlog.ts';
import cat from './cmd/cat.ts';
import chmod from './cmd/chmod.ts';
import chown from './cmd/chown.ts';
import cp from './cmd/cp.ts';
import debug from './cmd/debug.ts';
import df from './cmd/df.ts';
import du from './cmd/du.ts';
import echo from './cmd/echo.ts';
import find from './cmd/find.ts';
import free from './cmd/free.ts';
import fsck from './cmd/fsck.ts';
import grep from './cmd/grep.ts';
import help from './cmd/help.ts';
import id from './cmd/id.ts';
import kill from './cmd/kill.ts';
import ln from './cmd/ln.ts';
import ls from './cmd/ls.ts';
import lsof from './cmd/lsof.ts';
import man from './cmd/man.ts';
import mkdir from './cmd/mkdir.ts';
import mv from './cmd/mv.ts';
import nice from './cmd/nice.ts';
import pmap from './cmd/pmap.ts';
import predict from './cmd/predict.ts';
import ps from './cmd/ps.ts';
import pwd from './cmd/pwd.ts';
import quota from './cmd/quota.ts';
import reboot from './cmd/reboot.ts';
import renice from './cmd/renice.ts';
import rm from './cmd/rm.ts';
import rmdir from './cmd/rmdir.ts';
import semsearch from './cmd/semsearch.ts';
import shutdown from './cmd/shutdown.ts';
import stat from './cmd/stat.ts';
import su from './cmd/su.ts';
import svcctl from './cmd/svcctl.ts';
import swapctl from './cmd/swapctl.ts';
import top from './cmd/top.ts';
import touch from './cmd/touch.ts';
import tree from './cmd/tree.ts';
import uname from './cmd/uname.ts';
import uptime from './cmd/uptime.ts';
import vmstat from './cmd/vmstat.ts';
import whoami from './cmd/whoami.ts';
import type { CommandName, CommandState } from './lib/command.ts';
import type { Program } from './lib/sys.ts';

export type CoreProgram = Program<CommandState<unknown>>;

export const PROGRAMS = {
  ai,
  bootlog,
  cat,
  chmod,
  chown,
  cp,
  debug,
  df,
  du,
  echo,
  find,
  free,
  fsck,
  grep,
  help,
  id,
  kill,
  ln,
  ls,
  lsof,
  man,
  mkdir,
  mv,
  nice,
  pmap,
  predict,
  ps,
  pwd,
  quota,
  reboot,
  renice,
  rm,
  rmdir,
  semsearch,
  shutdown,
  stat,
  su,
  svcctl,
  swapctl,
  top,
  touch,
  tree,
  uname,
  uptime,
  vmstat,
  whoami,
} as const satisfies Record<CommandName, CoreProgram>;

/** The AI front ends, absent from the AI-off build (SHL-18, C12). */
export const AI_PROGRAMS: readonly CommandName[] = ['ai', 'semsearch', 'predict'];

export { ARGSPEC } from './lib/argspec.gen.ts';
