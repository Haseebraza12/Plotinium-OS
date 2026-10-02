import Bot from 'lucide-solid/icons/bot';
import Brain from 'lucide-solid/icons/brain';
import CircleDot from 'lucide-solid/icons/circle-dot';
import Cpu from 'lucide-solid/icons/cpu';
import Database from 'lucide-solid/icons/database';
import Flame from 'lucide-solid/icons/flame';
import Folder from 'lucide-solid/icons/folder';
import ListOrdered from 'lucide-solid/icons/list-ordered';
import Lock from 'lucide-solid/icons/lock';
import MemoryStick from 'lucide-solid/icons/memory-stick';
import NotebookPen from 'lucide-solid/icons/notebook-pen';
import PenLine from 'lucide-solid/icons/pen-line';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Settings from 'lucide-solid/icons/settings';
import Sparkles from 'lucide-solid/icons/sparkles';
import SquareTerminal from 'lucide-solid/icons/square-terminal';
import Zap from 'lucide-solid/icons/zap';

import type { IconComponent } from '../../primitives/internal/icon.ts';

const BY_NAME: Record<string, IconComponent> = {
  init: CircleDot,
  sched: ListOrdered,
  vfs: Database,
  syncd: RefreshCw,
  lockd: Lock,
  burn: Flame,
  memhog: MemoryStick,
  editor: PenLine,
  terminal: SquareTerminal,
  files: Folder,
  notes: NotebookPen,
  settings: Settings,
  'ai.indexer': Sparkles,
  'ai.agent': Bot,
  'ai.embed': Brain,
};

/** A small decorative glyph per process; `prefetch:*` jobs get the zap. Falls back to a chip. */
export function processIcon(name: string): IconComponent {
  if (name.startsWith('prefetch:')) return Zap;
  return BY_NAME[name] ?? Cpu;
}
