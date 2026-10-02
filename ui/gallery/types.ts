import type { JSX } from 'solid-js';

/**
 * Every file in ui/gallery/pages/ is a gallery page. It exports:
 *   export const meta: GalleryPageMeta = { id: 'dock', title: 'Dock', group: 'Shell', order: 10 };
 *   export default function DockPage(): JSX.Element { ... }
 * The registry discovers pages with import.meta.glob, so adding a page never edits a shared file.
 */
export interface GalleryPageMeta {
  /** URL id: #/<id>. Lower-case, unique. */
  id: string;
  title: string;
  /** Sidebar section. The foundation uses 'Foundations' and 'Primitives'. */
  group: string;
  /** Sort key inside the group (lower first). */
  order?: number;
  description?: string;
}

export interface GalleryPageModule {
  meta: GalleryPageMeta;
  default: () => JSX.Element;
}
