/**
 * The kernel-confirmation block rendered with ui's ANSI helpers (ui-design-system.md §3.8.15;
 * AGT-03, AGT-08, DSN-15, SHL-13): header, plan heading, steps with their red destructive word,
 * file disclosures, blast radius, reasons and the `Proceed? [y/N/e=edit]` prompt, every name
 * escaped. Whoever owns the TTY writes it (the kernel, or the Terminal's process host).
 */
import {
  formatConfirmationBlock,
  formatOutcome,
  toTerminalText,
} from '@plotinium/ui/apps/terminal';

import type { ConfirmOutcome, ConfirmPlan, ConfirmRenderer } from './host/host.ts';
import { confirmationModel } from './plan.ts';

export function confirmationText(plan: ConfirmPlan, cols: number): string {
  return `\r\n${toTerminalText(formatConfirmationBlock(confirmationModel(plan), cols))}`;
}

export function outcomeText(kind: ConfirmOutcome): string {
  switch (kind) {
    case 'declined':
      return formatOutcome({ kind: 'declined' });
    case 'timeout':
      return formatOutcome({ kind: 'timeout' });
    case 'edit-unavailable':
      return formatOutcome({ kind: 'rejected', reason: 'editing a plan is not available here' });
  }
}

export const ANSI_CONFIRM: ConfirmRenderer = {
  block: confirmationText,
  outcome: outcomeText,
};
