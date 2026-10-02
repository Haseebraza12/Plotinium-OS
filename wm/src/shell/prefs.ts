/**
 * Appearance preferences applied to the document root (visual-language-macos.md §3.7.2, DSN-05):
 * `data-theme` (absent follows the OS), `data-motion="reduce"` (the Settings override; the OS
 * setting applies through the media query either way), and the window preferences of contract C3
 * (`data-title-dblclick`, `data-minimise-effect`), which the window layer reads when the gesture
 * happens. Framework-free.
 */
import type { Prefs, ThemePref } from './env.ts';

export const DEFAULT_PREFS: Prefs = Object.freeze({
  theme: 'system',
  reducedMotion: false,
  frameMeter: false,
  focusMode: false,
  dockMagnification: true,
  clock24h: true,
  dockSize: 52,
  dockMagnifiedScale: 1.5,
  dockAutoHide: false,
  dockIndicators: true,
  titleDoubleClick: 'zoom',
  minimiseEffect: 'genie',
});

/** The Dock icon size Settings allows (px). */
export const DOCK_SIZE_RANGE = { min: 40, max: 80 } as const;
/** The magnified scale Settings allows. */
export const DOCK_SCALE_RANGE = { min: 1, max: 2 } as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Defaults filled in, and the numeric Dock values kept in the range Settings offers. */
export function withDefaults(p: Partial<Prefs> | undefined): Prefs {
  const merged: Prefs = { ...DEFAULT_PREFS, ...p };
  return {
    ...merged,
    dockSize: clamp(merged.dockSize, DOCK_SIZE_RANGE.min, DOCK_SIZE_RANGE.max, 52),
    dockMagnifiedScale: clamp(
      merged.dockMagnifiedScale,
      DOCK_SCALE_RANGE.min,
      DOCK_SCALE_RANGE.max,
      1.5,
    ),
  };
}

/** The theme actually drawn. */
export function resolvedTheme(theme: ThemePref, systemDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** The dataset of the root element. */
export interface RootLike {
  readonly dataset: DOMStringMap;
}

export function applyPrefs(root: RootLike, p: Prefs): void {
  if (p.theme === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = p.theme;
  if (p.reducedMotion) root.dataset['motion'] = 'reduce';
  else delete root.dataset['motion'];
  // Contract C3 (UI-040 / UI-041): the window layer reads these at the moment of the gesture and
  // treats an absent attribute as the default (zoom, genie), so only other values are written.
  if (p.titleDoubleClick === 'zoom') delete root.dataset['titleDblclick'];
  else root.dataset['titleDblclick'] = p.titleDoubleClick;
  if (p.minimiseEffect === 'genie') delete root.dataset['minimiseEffect'];
  else root.dataset['minimiseEffect'] = p.minimiseEffect;
}
