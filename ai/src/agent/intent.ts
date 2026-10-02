/**
 * Intent binding and argument grounding (agentic-shell.md §3.10, §5.2; AGT-06, INJ-20 layer L4/L5).
 *
 * - Span check: each step's `span` is a verbatim substring of the request or of a clarification
 *   answer, after NFC and whitespace collapsing; case is significant. Else EINVAL
 *   `span-not-in-request`.
 * - Verb lexicon: the step's op class must be licensed by a lexeme inside its span (whole words,
 *   case-insensitive, inflections listed explicitly). A DESTRUCTIVE class without a lexeme rejects
 *   the whole plan with EPERM `not-requested` (this is what stops an injected `rm`); a
 *   non-destructive one is kept and flagged UNLICENSED, which forces confirmation.
 * - Grounding: a path argument must come from the request or a clarification (after `~`
 *   expansion, case-insensitive), a set bound by an earlier `find`, or an observation of this
 *   request; otherwise it is flagged UNGROUNDED (confirmation forced).
 * - Plotinium hardening (validator.ts): a DESTRUCTIVE step whose path argument is ungrounded is
 *   rejected with EPERM `not-requested` instead of only forcing confirmation, so the INJ-20
 *   blind-yes gate (no destructive unrequested step executes) holds (ai-safety §3.7).
 * - A user-edited plan skips the span and lexicon checks (the user is the source).
 */
import type { PlanStep, PlanStepOp } from '@plotinium/protocol';

import { type Result, fail, ok } from '../util/errors.ts';

export type OpClass =
  | 'create-dir'
  | 'create-file'
  | 'copy'
  | 'move'
  | 'link'
  | 'delete'
  | 'permissions'
  | 'ownership'
  | 'overwrite'
  | 'selector';

/** Inflections are listed explicitly (§3.10); multi-word lexemes match across any whitespace. */
export const LEXICON: Readonly<Record<Exclude<OpClass, 'selector'>, readonly string[]>> = {
  'create-dir': [
    'make',
    'makes',
    'made',
    'making',
    'create',
    'creates',
    'created',
    'creating',
    'new folder',
    'new folders',
    'new directory',
    'new directories',
    'mkdir',
    'set up',
    'sets up',
    'setting up',
    'organise',
    'organises',
    'organised',
    'organising',
    'organize',
    'organizes',
    'organized',
    'organizing',
    'sort into',
    'sorts into',
    'sorted into',
    'sorting into',
    'group',
    'groups',
    'grouped',
    'grouping',
  ],
  'create-file': [
    'create',
    'creates',
    'created',
    'creating',
    'make',
    'makes',
    'made',
    'making',
    'touch',
    'touches',
    'touched',
    'touching',
    'write',
    'writes',
    'wrote',
    'written',
    'writing',
    'save',
    'saves',
    'saved',
    'saving',
    'add',
    'adds',
    'added',
    'adding',
    'new file',
    'new files',
    'note',
    'notes',
  ],
  copy: [
    'copy',
    'copies',
    'copied',
    'copying',
    'duplicate',
    'duplicates',
    'duplicated',
    'duplicating',
    'back up',
    'backs up',
    'backed up',
    'backing up',
    'backup',
    'backups',
    'cp',
    'clone',
    'clones',
    'cloned',
    'cloning',
  ],
  move: [
    'move',
    'moves',
    'moved',
    'moving',
    'mv',
    'rename',
    'renames',
    'renamed',
    'renaming',
    'put',
    'puts',
    'putting',
    'place',
    'places',
    'placed',
    'placing',
    'relocate',
    'relocates',
    'relocated',
    'relocating',
    'organise',
    'organises',
    'organised',
    'organising',
    'organize',
    'organizes',
    'organized',
    'organizing',
    'sort',
    'sorts',
    'sorted',
    'sorting',
    'file into',
    'files into',
    'filed into',
    'filing into',
    'archive',
    'archives',
    'archived',
    'archiving',
    'change extension',
    'change the extension',
    'change extensions',
    'change the extensions',
  ],
  // Plotinium design: agentic-shell.md §3.10 has no row for symlink; it is a non-destructive create.
  link: [
    'link',
    'links',
    'linked',
    'linking',
    'symlink',
    'symlinks',
    'shortcut',
    'shortcuts',
    'alias',
    'ln',
  ],
  delete: [
    'delete',
    'deletes',
    'deleted',
    'deleting',
    'remove',
    'removes',
    'removed',
    'removing',
    'rm',
    'erase',
    'erases',
    'erased',
    'erasing',
    'clean up',
    'cleans up',
    'cleaned up',
    'cleaning up',
    'clean out',
    'cleans out',
    'cleaned out',
    'cleaning out',
    'get rid of',
    'getting rid of',
    'got rid of',
    'trash',
    'trashes',
    'trashed',
    'trashing',
    'purge',
    'purges',
    'purged',
    'purging',
    'wipe',
    'wipes',
    'wiped',
    'wiping',
    'discard',
    'discards',
    'discarded',
    'discarding',
  ],
  permissions: [
    'permission',
    'permissions',
    'read-only',
    'readonly',
    'writable',
    'writeable',
    'executable',
    'chmod',
    'private',
    'public',
    'share',
    'shares',
    'shared',
    'sharing',
    'lock down',
    'locks down',
    'locked down',
    'locking down',
    'restrict',
    'restricts',
    'restricted',
    'restricting',
  ],
  ownership: [
    'owner',
    'owners',
    'ownership',
    'chown',
    'give',
    'gives',
    'gave',
    'given',
    'giving',
    'transfer',
    'transfers',
    'transferred',
    'transferring',
  ],
  overwrite: [
    'replace',
    'replaces',
    'replaced',
    'replacing',
    'overwrite',
    'overwrites',
    'overwrote',
    'overwritten',
    'overwriting',
  ],
};

export const DESTRUCTIVE: ReadonlySet<OpClass> = new Set([
  'delete',
  'permissions',
  'ownership',
  'overwrite',
]);

/** The op class of a plan-step op (§3.10 table). */
export function opClassOf(op: PlanStepOp): OpClass {
  switch (op) {
    case 'mkdir':
      return 'create-dir';
    case 'write':
    case 'utimes':
      return 'create-file';
    case 'copy':
      return 'copy';
    case 'rename':
      return 'move';
    case 'symlink':
      return 'link';
    case 'unlink':
      return 'delete';
    case 'chmod':
      return 'permissions';
    case 'chown':
      return 'ownership';
    case 'find':
    case 'glob':
      return 'selector';
  }
}

export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive match of a (possibly multi-word) lexeme. */
export function wordMatch(text: string, lexeme: string): boolean {
  const body = lexeme.split(/\s+/u).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export function licensed(span: string, cls: Exclude<OpClass, 'selector'>): boolean {
  return LEXICON[cls].some((lex) => wordMatch(span, lex));
}

export interface BindingInput {
  steps: readonly PlanStep[];
  request: string;
  clarifications: readonly string[];
  userEdited: boolean;
  /** Step ids that the overlay found to replace an existing name. */
  overwrites: ReadonlySet<string>;
}

export interface BindingFlags {
  /** Non-destructive steps without a licensing lexeme. */
  unlicensed: string[];
}

/** Span and lexicon checks; the first failure rejects the whole plan. */
export function bindIntent(input: BindingInput): Result<BindingFlags> {
  const unlicensed: string[] = [];
  if (input.userEdited) return ok({ unlicensed });
  const sources = [input.request, ...input.clarifications].map(normalizeText);
  for (const step of input.steps) {
    const span = normalizeText(step.span);
    if (span === '' || !sources.some((s) => s.includes(span)))
      return fail('EINVAL', 'span-not-in-request', step.id);
    const classes: OpClass[] = [opClassOf(step.op)];
    if (input.overwrites.has(step.id)) classes.push('overwrite');
    for (const cls of classes) {
      if (cls === 'selector') continue;
      if (licensed(span, cls)) continue;
      if (DESTRUCTIVE.has(cls)) return fail('EPERM', 'not-requested', step.id);
      unlicensed.push(step.id);
    }
  }
  return ok({ unlicensed });
}

export interface GroundingContext {
  request: string;
  clarifications: readonly string[];
  cwd: string;
  home: string;
  /** Paths returned by observations of this request. */
  observed: ReadonlySet<string>;
}

function relativeForms(path: string, ctx: GroundingContext): string[] {
  const forms = [path];
  if (path === ctx.home) forms.push('~');
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base !== '') forms.push(base);
  if (path.startsWith(`${ctx.home}/`))
    forms.push(`~${path.slice(ctx.home.length)}`, path.slice(ctx.home.length + 1));
  if (path.startsWith(`${ctx.cwd}/`)) forms.push(path.slice(ctx.cwd.length + 1));
  return forms;
}

/**
 * Whether an absolute path argument is attributable to the user's words or to what the agent
 * observed (§3.10 "argument grounding"). Paths bound through `sources` are grounded by the set.
 */
export function isGrounded(path: string, ctx: GroundingContext): boolean {
  if (ctx.observed.has(path)) return true;
  const texts = [ctx.request, ...ctx.clarifications].map((t) => t.normalize('NFC').toLowerCase());
  return relativeForms(path, ctx).some((form) => {
    const f = form.normalize('NFC').toLowerCase();
    return texts.some((t) => t.includes(f));
  });
}
