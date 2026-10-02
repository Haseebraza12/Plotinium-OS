/**
 * ANSI formatting helpers for the Terminal: the shell prompt, the agent's observation lines and
 * the kernel confirmation block of ui-design-system.md §3.8.15 (AGT-03, AGT-08, DSN-15, SHL-13).
 *
 * Everything here is a pure string function. The kernel TTY writer (or a test, or the gallery)
 * feeds the result to xterm. Colour always rides on top of text: a destructive step names its
 * operation in words, the default answer is named in the prompt, and success and failure lines
 * start with ✓ or ✗ (DSN-08). File names and command lines are escaped before they are
 * printed, so a crafted name cannot move the cursor or reverse the text direction (SHL-13).
 */

/** The 16 ANSI palette slots. Their colours come from tokens (./theme.ts, DSN-13). */
export const ANSI = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,
} as const;

export type AnsiIndex = (typeof ANSI)[keyof typeof ANSI];

export interface SgrStyle {
  fg?: AnsiIndex;
  bg?: AnsiIndex;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export const CSI = '\u001b[';
export const RESET = `${CSI}0m`;
/** Carriage return plus line feed: xterm needs the CR when the TTY is in raw mode. */
export const CRLF = '\r\n';

function fgCode(index: AnsiIndex): number {
  return index < 8 ? 30 + index : 90 + (index - 8);
}
function bgCode(index: AnsiIndex): number {
  return index < 8 ? 40 + index : 100 + (index - 8);
}

/** The SGR parameters for a style, in a stable order. */
export function sgrCodes(style: SgrStyle): number[] {
  const codes: number[] = [];
  if (style.bold === true) codes.push(1);
  if (style.dim === true) codes.push(2);
  if (style.italic === true) codes.push(3);
  if (style.underline === true) codes.push(4);
  if (style.inverse === true) codes.push(7);
  if (style.fg !== undefined) codes.push(fgCode(style.fg));
  if (style.bg !== undefined) codes.push(bgCode(style.bg));
  return codes;
}

/** Wraps text in an SGR sequence and a reset. An empty style returns the text unchanged. */
export function sgr(text: string, style: SgrStyle): string {
  const codes = sgrCodes(style);
  if (codes.length === 0 || text === '') return text;
  return `${CSI}${codes.join(';')}m${text}${RESET}`;
}

export const bold = (text: string): string => sgr(text, { bold: true });
export const dim = (text: string): string => sgr(text, { dim: true });
export const red = (text: string): string => sgr(text, { fg: ANSI.red });
export const green = (text: string): string => sgr(text, { fg: ANSI.green });

// ESC [ … final byte (CSI), ESC ] … BEL or ESC \ (OSC), and lone two-byte escapes.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;

/** Removes every escape sequence, leaving the text a screen reader or a copy would get. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Terminal cells taken by text: escapes count 0, combining marks 0, wide (CJK, emoji) 2. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (/\p{Mn}|\p{Me}/u.test(char) || codePoint === 0x200d) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/** Pads with spaces to a visible width (styled text keeps its escapes). */
export function padVisible(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** C0 and C1 controls, DEL, and the bidirectional embeddings, overrides and isolates. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;

/**
 * Kernel-confirmation escaping (§3.8.15, SHL-13): every control or bidirectional character is
 * shown as `\u{…}`, so the user sees exactly which bytes a name holds.
 */
export function escapeForConfirmation(text: string): string {
  return text.replace(
    UNSAFE,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/** Shell-listing escaping (shell-and-terminal.md §3.13): unsafe characters become `?`. */
export function sanitizeForTty(text: string): string {
  return text.replace(UNSAFE, '?');
}

// ---------------------------------------------------------------------------------------------
// Prompt and agent lines
// ---------------------------------------------------------------------------------------------

export interface PromptParts {
  user: string;
  host: string;
  /** Working directory as the shell shows it, e.g. `~/notes`. */
  cwd: string;
  /** Root gets `#` and a red user part, so the elevated state has a colour and a character cue. */
  root?: boolean;
}

/** `alice@plotinium:~/notes$ ` (ui-design-system.md §3.8.10). */
export function formatPrompt(parts: PromptParts): string {
  const who = sgr(`${sanitizeForTty(parts.user)}@${sanitizeForTty(parts.host)}`, {
    fg: parts.root === true ? ANSI.red : ANSI.green,
    bold: true,
  });
  const where = sgr(sanitizeForTty(parts.cwd), { fg: ANSI.blue, bold: true });
  return `${who}:${where}${parts.root === true ? '#' : '$'} `;
}

/** A dim agent progress line: `ai: looking: find ~ -type f … 12 files · 38 ms`. */
export function formatAgentNote(stage: string, detail: string): string {
  return dim(`ai: ${stage}: ${escapeForConfirmation(detail)}`);
}

// ---------------------------------------------------------------------------------------------
// Kernel confirmation block (§3.8.15)
// ---------------------------------------------------------------------------------------------

/** Words the kernel's confirmation predicate uses for a destructive step (ConfirmReason). */
export type DestructiveWord = 'delete' | 'overwrite' | 'chmod' | 'chown';

export interface PlanLine {
  /** The program, e.g. `mkdir`, `find`, `mv`, `chmod`. */
  command: string;
  /** Its arguments as typed; escaped before printing. */
  args: string;
  /** The dry-run effect, e.g. `create 1 dir`, `→ 12 files`, `modify 13 inodes`. */
  effect: string;
  /** Set when the step is destructive: the word is printed in red AND as text. */
  destructive?: DestructiveWord;
  /** Files the step matched; the first three are named in the collapsed disclosure. */
  files?: readonly string[];
  /** Total matches when `files` is a sample (defaults to its length). */
  fileCount?: number;
}

export interface ConfirmationHeader {
  agent: string;
  pid: number;
}

/** `── Kernel confirmation · ai.agent (pid 812) ───…` in bright blue, bold. */
export function formatConfirmationHeader(header: ConfirmationHeader, width = 72): string {
  const title = `── Kernel confirmation · ${escapeForConfirmation(header.agent)} (pid ${header.pid}) `;
  const rule = '─'.repeat(Math.max(3, width - visibleWidth(title)));
  return sgr(title + rule, { fg: ANSI.brightBlue, bold: true });
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `Plan · 4 steps · 1 transaction`. */
export function formatPlanHeading(steps: number, transactions = 1): string {
  return bold(`Plan · ${plural(steps, 'step')} · ${plural(transactions, 'transaction')}`);
}

export interface PlanLayout {
  /** Terminal columns; the argument column shrinks to fit. */
  cols?: number;
}

/** One step row: `  4  chmod   -R o-w ~/reports                   chmod · modify 13 inodes`. */
export function formatPlanStep(index: number, step: PlanLine, layout: PlanLayout = {}): string {
  const cols = layout.cols ?? 80;
  const number = String(index).padStart(3);
  const command = padVisible(escapeForConfirmation(step.command), 8);
  const effectText = escapeForConfirmation(step.effect);
  const effect =
    step.destructive === undefined
      ? effectText
      : `${sgr(step.destructive, { fg: ANSI.red, bold: true })} · ${effectText}`;
  const effectWidth = visibleWidth(effect);
  const argsWidth = Math.max(12, Math.min(48, cols - 3 - 2 - 8 - 2 - effectWidth));
  const args = escapeForConfirmation(step.args);
  const argsCell =
    visibleWidth(args) > argsWidth ? `${args}  ` : padVisible(args, argsWidth) + '  ';
  return `${number}  ${command}${argsCell}${effect}`;
}

/** The disclosure under a step that matched files: `       ▸ show 12 files · a.pdf, b.pdf …`. */
export function formatStepFiles(files: readonly string[], total = files.length): string {
  const shown = files.slice(0, 3).map(escapeForConfirmation).join(', ');
  const more = total > 3 ? ' …' : '';
  return dim(`       ▸ show ${plural(total, 'file')} · ${shown}${more}`);
}

export interface BlastRadiusView {
  inodes: number;
  deletions: number;
  overwrites: number;
  quotaOk: boolean;
  /** Shown instead of "within quota" when quotaOk is false, e.g. `over quota by 38 MB`. */
  quotaText?: string;
}

/** `Blast radius: 13 inodes · 0 deletions · 0 overwrites · within quota`. */
export function formatBlastRadius(blast: BlastRadiusView): string {
  const risky = (count: number, noun: string): string =>
    sgr(plural(count, noun), count === 0 ? { fg: ANSI.green } : { fg: ANSI.red, bold: true });
  const quota = blast.quotaOk
    ? green('within quota')
    : sgr(blast.quotaText ?? 'over quota', { fg: ANSI.red, bold: true });
  return [
    `Blast radius: ${plural(blast.inodes, 'inode')}`,
    risky(blast.deletions, 'deletion'),
    risky(blast.overwrites, 'overwrite'),
    quota,
  ].join(' · ');
}

/** `Needs confirmation because: chmod` with each reason in red and in text. */
export function formatConfirmReasons(reasons: readonly string[]): string {
  const list = reasons.map((r) => sgr(escapeForConfirmation(r), { fg: ANSI.red, bold: true }));
  return `Needs confirmation because: ${list.join(', ')}`;
}

/**
 * `Proceed? [y/N/e=edit] `: N is the default (DSN-15), so it is capitalised, bold and in the
 * accent slot; the hint names the default in words for screen readers.
 */
export function formatProceedPrompt(options: { hint?: boolean } = {}): string {
  const n = sgr('N', { fg: ANSI.magenta, bold: true, underline: true });
  const hint = options.hint === false ? '' : ` ${dim('N is the default · Enter declines')}`;
  return `Proceed? [y/${n}/e=edit]${hint} `;
}

export type PlanOutcome =
  | { kind: 'committed'; ms: number; txn: string }
  | { kind: 'committed-offline'; txn: string }
  | { kind: 'declined' }
  | { kind: 'timeout' }
  | { kind: 'rejected'; reason: string };

/** The result line after the answer (§3.8.15). */
export function formatOutcome(outcome: PlanOutcome): string {
  switch (outcome.kind) {
    case 'committed': {
      const txn = escapeForConfirmation(outcome.txn);
      return `${green(`✓ committed in ${outcome.ms} ms · txn ${txn} · undo with: `)}${sgr(
        `ai undo ${txn}`,
        { fg: ANSI.green, bold: true },
      )}`;
    }
    case 'committed-offline':
      return sgr(
        `✓ committed locally · sync pending (offline) · txn ${escapeForConfirmation(outcome.txn)}`,
        { fg: ANSI.yellow },
      );
    case 'declined':
      return dim('✗ declined — nothing ran');
    case 'timeout':
      return dim('✗ confirmation timed out — nothing ran');
    case 'rejected':
      return red(`✗ rejected: ${escapeForConfirmation(outcome.reason)} — nothing ran`);
  }
}

export interface ConfirmationBlock {
  header: ConfirmationHeader;
  steps: readonly PlanLine[];
  transactions?: number;
  blast: BlastRadiusView;
  /** ConfirmReason values; an empty list omits the "Needs confirmation" line. */
  reasons: readonly string[];
}

/**
 * The full block, one string per line and without line endings (join with CRLF for xterm):
 * header, plan heading, steps (with their file disclosures), blast radius, reasons and the
 * prompt. With no reasons the prompt is left out, since the plan runs without confirmation.
 */
export function formatConfirmationBlock(block: ConfirmationBlock, cols = 80): string[] {
  const lines = [
    formatConfirmationHeader(block.header, Math.min(cols, 76)),
    formatPlanHeading(block.steps.length, block.transactions ?? 1),
  ];
  block.steps.forEach((step, i) => {
    lines.push(formatPlanStep(i + 1, step, { cols }));
    if (step.files !== undefined && step.files.length > 0)
      lines.push(formatStepFiles(step.files, step.fileCount ?? step.files.length));
  });
  lines.push(formatBlastRadius(block.blast));
  if (block.reasons.length > 0) {
    lines.push(formatConfirmReasons(block.reasons));
    lines.push(formatProceedPrompt());
  }
  return lines;
}

/** Joins lines for xterm (CRLF between them). */
export function toTerminalText(lines: readonly string[]): string {
  return lines.join(CRLF);
}
