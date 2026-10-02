import Contrast from 'lucide-solid/icons/contrast';
import Gauge from 'lucide-solid/icons/gauge';
import HardDrive from 'lucide-solid/icons/hard-drive';
import Info from 'lucide-solid/icons/info';
import MemoryStick from 'lucide-solid/icons/memory-stick';
import PanelBottom from 'lucide-solid/icons/panel-bottom';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Settings from 'lucide-solid/icons/settings';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import Download from 'lucide-solid/icons/download';
import Users from 'lucide-solid/icons/users';

import type { IconComponent } from '../../primitives/internal/icon.ts';
import type { Tint } from '../../primitives/sidebar/SidebarList.tsx';
import type { SettingsSectionId } from './models.ts';

export interface SectionMeta {
  id: SettingsSectionId;
  label: string;
  icon: IconComponent;
  tint: Tint;
  /** Sidebar group (a hairline separates groups). */
  group: 0 | 1 | 2 | 3;
  /** Words that find this section from the sidebar search. */
  keywords: readonly string[];
}

/** The sidebar, in order (settings-about reference). */
export const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings,
    tint: 'gray',
    group: 0,
    keywords: [
      'name',
      'device',
      'language',
      'clock',
      '24-hour',
      'time',
      'boot',
      'verbose',
      'startup',
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Contrast,
    tint: 'blue',
    group: 0,
    keywords: [
      'theme',
      'dark',
      'light',
      'accent',
      'colour',
      'color',
      'motion',
      'animation',
      'transparency',
      'glass',
    ],
  },
  {
    id: 'desktop',
    label: 'Desktop & Dock',
    icon: PanelBottom,
    tint: 'indigo',
    group: 0,
    keywords: ['dock', 'magnification', 'minimise', 'genie', 'windows', 'title bar', 'hide'],
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: MemoryStick,
    tint: 'teal',
    group: 1,
    keywords: ['budget', 'ram', 'swap', 'soft limit', 'paging', 'reclaim', 'watermark'],
  },
  {
    id: 'scheduler',
    label: 'Scheduler',
    icon: Gauge,
    tint: 'orange',
    group: 1,
    keywords: ['quantum', 'quanta', 'aging', 't_age', 'starvation', 'priority', 'band'],
  },
  {
    id: 'network',
    label: 'Network & Sync',
    icon: RefreshCw,
    tint: 'green',
    group: 1,
    keywords: ['sync', 'server', 'offline', 'online', 'cloud', 'write-behind'],
  },
  {
    id: 'privacy',
    label: 'Privacy & AI',
    icon: ShieldCheck,
    tint: 'purple',
    group: 2,
    keywords: [
      'telemetry',
      'ai',
      'agent',
      'index',
      'embedding',
      'model',
      'predictions',
      'budget',
      'confirmation',
      'log',
    ],
  },
  {
    id: 'users',
    label: 'Users & Groups',
    icon: Users,
    tint: 'blue',
    group: 2,
    keywords: ['account', 'password', 'guest', 'group', 'uid', 'forget'],
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: HardDrive,
    tint: 'gray',
    group: 3,
    keywords: ['disk', 'opfs', 'quota', 'trash', 'space'],
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: Download,
    tint: 'red',
    group: 3,
    keywords: ['update', 'version', 'channel', 'restart', 'beta'],
  },
  {
    id: 'about',
    label: 'About',
    icon: Info,
    tint: 'indigo',
    group: 3,
    keywords: [
      'version',
      'build',
      'kernel',
      'team',
      'licences',
      'licenses',
      'system report',
      'uname',
    ],
  },
];

export function sectionMeta(id: SettingsSectionId): SectionMeta {
  const meta = SECTIONS.find((s) => s.id === id);
  if (meta === undefined) throw new Error(`unknown settings section ${id}`);
  return meta;
}

/**
 * Sections matching a sidebar search: the label or any keyword contains the query
 * (case-insensitive). An empty query matches every section. O(sections × keywords).
 */
export function searchSections(
  query: string,
  sections: readonly SectionMeta[] = SECTIONS,
): SectionMeta[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...sections];
  return sections.filter(
    (s) => s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q)),
  );
}
