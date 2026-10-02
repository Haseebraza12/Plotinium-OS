import type { GalleryPageMeta, GalleryPageModule } from './types.ts';

/** Group order in the sidebar; unknown groups follow in alphabetical order. */
const GROUP_ORDER = ['Foundations', 'Primitives', 'Boot', 'Shell', 'Windows', 'Apps', 'System'];

export interface GalleryPage extends GalleryPageMeta {
  component: GalleryPageModule['default'];
}

function isPageModule(value: unknown): value is GalleryPageModule {
  if (typeof value !== 'object' || value === null) return false;
  const mod = value as Partial<GalleryPageModule>;
  return (
    typeof mod.default === 'function' &&
    typeof mod.meta?.id === 'string' &&
    typeof mod.meta.title === 'string'
  );
}

const modules = import.meta.glob('./pages/*.tsx', { eager: true });

function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  return index < 0 ? GROUP_ORDER.length : index;
}

/** Every page, sorted by group, then order, then title. Files that are not pages are skipped. */
export const PAGES: readonly GalleryPage[] = Object.values(modules)
  .filter(isPageModule)
  .map((mod) => ({ ...mod.meta, group: mod.meta.group, component: mod.default }))
  .sort(
    (a, b) =>
      groupRank(a.group) - groupRank(b.group) ||
      a.group.localeCompare(b.group) ||
      (a.order ?? 100) - (b.order ?? 100) ||
      a.title.localeCompare(b.title),
  );

export function pagesByGroup(
  pages: readonly GalleryPage[],
): { group: string; pages: GalleryPage[] }[] {
  const groups = new Map<string, GalleryPage[]>();
  for (const page of pages) {
    const list = groups.get(page.group) ?? [];
    list.push(page);
    groups.set(page.group, list);
  }
  return [...groups].map(([group, list]) => ({ group, pages: list }));
}
