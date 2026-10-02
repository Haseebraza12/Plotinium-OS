/**
 * Every system-call name of the catalogue in syscall-abi.md §4.4, in catalogue order.
 *
 * Kept apart from registry.ts so that audit.ts can name calls without importing every schema
 * module (the registry imports the agent module, which imports the audit record). The registry
 * `satisfies Record<CallName, CallSpec>`, so this list and CALLS cannot drift apart.
 */
import * as v from 'valibot';

export const CALL_NAMES = [
  // §4.4.1 processes and job control
  'spawn',
  'exit',
  'wait',
  'kill',
  'getpid',
  'proc.cred',
  'getcwd',
  'chdir',
  'umask',
  'nice',
  'setpriority',
  'getpriority',
  'setpgid',
  'sig.action',
  'proc.list',
  'proc.info',
  // §4.4.2 files
  'open',
  'read',
  'write',
  'writeFile',
  'close',
  'seek',
  'stat',
  'lstat',
  'fstat',
  'readdir',
  'mkdir',
  'rmdir',
  'unlink',
  'rename',
  'symlink',
  'readlink',
  'link',
  'chmod',
  'chown',
  'truncate',
  'utimes',
  'statfs',
  'quota',
  'copy',
  'find',
  'grep',
  'du',
  'wc',
  'lsof',
  'batch',
  // §4.4.3 descriptors, pipes and TTYs
  'pipe',
  'dup',
  'dup2',
  'isatty',
  'tty.open',
  'tty.input',
  'tty.resize',
  'tty.getattr',
  'tty.setattr',
  'tcsetpgrp',
  'tcgetpgrp',
  // §4.4.4 windows and notifications
  'window.create',
  'window.close',
  'window.focus',
  'window.setTitle',
  'window.setCloseGuard',
  'window.requestAttention',
  'notify.post',
  // §4.4.5 memory
  'mem.alloc',
  'mem.declare',
  'mem.free',
  'mem.stat',
  'mem.prefetch',
  'mem.hint',
  'mmap',
  'msync',
  'munmap',
  // §4.4.6 time
  'time.now',
  'sleep',
  'uptime',
  // §4.4.7 locks
  'lock.acquire',
  'lock.release',
  'lock.status',
  // §4.4.8 network and sync status
  'net.status',
  'sync.flush',
  // §4.4.9 events
  'sys.subscribe',
  'sys.events',
  // §4.4.10 AI: A semantic search, B agentic shell, C prediction and telemetry
  'ai.semsearch',
  'ai.search.focus',
  'ai.index.status',
  'ai.index.lookup',
  'ai.index.embed',
  'ai.index.put',
  'ai.index.drop',
  'ai.search.serve',
  'ai.search.done',
  'ai.agent.plan',
  'ai.agent.submit',
  'ai.agent.confirm',
  'ai.agent.log',
  'ai.undo',
  'ai.predict',
  'ai.predict.publish',
  'ai.telemetry.read',
  'ai.telemetry.clear',
  'ai.telemetry.export',
  'ai.telemetry.optin',
  // §4.4.11 system and administration
  'uname',
  'users.list',
  'bootlog',
  'dmesg',
  'svc.status',
  'svc.restart',
  'sysctl.get',
  'sysctl.set',
  'shutdown',
  'reboot',
  'su',
  'auth.login',
  'auth.logout',
  'auth.lock',
  'fsck',
  'debug.inject',
  'debug.delay',
] as const;

export type CallName = (typeof CALL_NAMES)[number];

export const CallName = v.picklist(CALL_NAMES);

/** The AI group: absent from the AI-off build, where every `ai.*` name answers ENOSYS (C12). */
export function isAiCall(name: string): boolean {
  return name.startsWith('ai.');
}
