/**
 * Realistic sample data for the agent confirmation sheet (tests and the gallery), from
 * docs/design/stitch/agent-confirm-sheet. The counts are consistent: 19 inodes deleted to the
 * trash, 1 moved, 4 re-moded (one is the moved file), 23 distinct inodes.
 */
import type { AgentBlastRadius, AgentConfirmReason, AgentPlanStep } from './AgentConfirmSheet.tsx';

export const AGENT_REQUEST = 'clean up my old build folders and lock down the lab3 notes';

export const AGENT_STEPS: readonly AgentPlanStep[] = [
  {
    id: 's1',
    op: 'DELETE',
    path: '~/projects/lab2/build/',
    effect: 'remove 1 dir, 9 files',
    effectNote: 'to trash',
  },
  {
    id: 's2',
    op: 'DELETE',
    path: '~/projects/lab3/build/',
    effect: 'remove 1 dir, 6 files',
    effectNote: 'to trash',
  },
  {
    id: 's3',
    op: 'DELETE',
    path: '~/projects/os-sim/.cache/',
    effect: 'remove 1 dir, 1 file',
    effectNote: 'to trash',
  },
  {
    id: 's4',
    op: 'MOVE',
    path: '~/notes/lab3-vfs.md',
    target: '~/notes/archive/',
    effect: 'modify 1 entry',
  },
  { id: 's5', op: 'CHMOD', path: '~/notes/archive/', args: '-R go-rwx', effect: 'modify 4 inodes' },
];

export const AGENT_BLAST: AgentBlastRadius = {
  inodes: 23,
  deletions: 3,
  overwrites: 0,
  recoverable: true,
};

export const AGENT_REASONS: readonly AgentConfirmReason[] = [
  { kind: 'delete', text: 'Deletes files (3 directories, 16 files)', code: 'DELETE' },
  {
    kind: 'over-20-inodes',
    text: 'Touches more than 20 inodes (23 > threshold 20)',
    code: 'BLAST_RADIUS',
  },
  { kind: 'chmod', text: 'Changes permissions on ~/notes/archive/', code: 'CHMOD' },
];

export const AGENT_POLICY =
  'agent.confirm.destructive = always · deleted items go to ~/.trash/8f2c/';
