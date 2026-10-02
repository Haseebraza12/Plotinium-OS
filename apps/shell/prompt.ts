/**
 * Prompt strings (shell-and-terminal.md §3.4 "Prompt"; colours from ui-design-system.md §3.8.10:
 * `user@host` bold green, bold red for root; the path bold blue).
 */
import type { ShellState } from './state.ts';
import { varOr } from './state.ts';

export function defaultPs1(uid: number): string {
  const user = uid === 0 ? '\\e[1;31m' : '\\e[1;32m';
  return `\\[${user}\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ `;
}

export const DEFAULT_PS2 = '> ';

/** `$HOME` shown as `~` (§3.4 `\w`). */
export function tildePath(path: string, home: string): string {
  if (home.length > 1 && (path === home || path.startsWith(`${home}/`)))
    return `~${path.slice(home.length)}`;
  return path;
}

/** Expands `\u \h \w \W \$ \\ \e \[ \]` (the last two mark non-printing text and are dropped). */
export function expandPrompt(ps: string, st: ShellState): string {
  const home = varOr(st, 'HOME', '');
  const pwd = varOr(st, 'PWD', '');
  return ps.replace(/\\(.)/gsu, (m, c: string) => {
    switch (c) {
      case 'u':
        return varOr(st, 'USER', '');
      case 'h':
        return varOr(st, 'HOSTNAME', 'plotinium').split('.')[0] ?? '';
      case 'w':
        return tildePath(pwd, home);
      case 'W': {
        const w = tildePath(pwd, home);
        return w === '/' || w === '~' ? w : (w.split('/').at(-1) ?? w);
      }
      case '$':
        return st.uid === 0 ? '#' : '$';
      case '\\':
        return '\\';
      case 'e':
        return '\x1b';
      case '[':
      case ']':
        return '';
      default:
        return m;
    }
  });
}
