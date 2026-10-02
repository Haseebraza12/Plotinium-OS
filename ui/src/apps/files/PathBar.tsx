import ChevronRight from 'lucide-solid/icons/chevron-right';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { Menu } from '../../primitives/menu/Menu.tsx';
import styles from './Files.module.css';

export interface PathSegment {
  label: string;
  path: string;
}

/** `/home/student/notes` → `/`, `home`, `student`, `notes` with their paths. */
export function pathSegments(path: string): PathSegment[] {
  const parts = path.split('/').filter(Boolean);
  const out: PathSegment[] = [{ label: '/', path: '/' }];
  parts.forEach((part, i) =>
    out.push({ label: part, path: `/${parts.slice(0, i + 1).join('/')}` }),
  );
  return out;
}

/** Which segments show, and which fold into the "…" menu (in path order). */
export interface PathFold {
  head: PathSegment[];
  hidden: PathSegment[];
  tail: PathSegment[];
}

/** Rendered widths in px: each segment's crumb, a separator, the "…" button, the flex gap. */
export interface PathMetrics {
  crumbs: readonly number[];
  separator: number;
  ellipsis: number;
  gap: number;
}

/** The width a fold takes: its crumbs, the "…" item when something is hidden, separators, gaps. */
export function foldWidth(fold: PathFold, all: readonly PathSegment[], m: PathMetrics): number {
  const widthOf = (s: PathSegment): number => m.crumbs[all.indexOf(s)] ?? 0;
  const shown = [...fold.head, ...fold.tail];
  const items = shown.length + (fold.hidden.length > 0 ? 1 : 0);
  if (items === 0) return 0;
  const crumbs = shown.reduce((sum, s) => sum + widthOf(s), 0);
  const ellipsis = fold.hidden.length > 0 ? m.ellipsis : 0;
  // Crumbs and separators are siblings of one flex row: 2n - 1 items, 2n - 2 gaps.
  return crumbs + ellipsis + (items - 1) * m.separator + (2 * items - 2) * m.gap;
}

/**
 * The breadcrumb for the space there is (UI-010): the whole path when it fits; otherwise the
 * root, a "…" for the middle folders and as many trailing folders as fit; the current folder is
 * always shown (it is the one that shrinks with an ellipsis when even "/ › … › current" is too
 * wide, and then the root folds into the menu too). Without metrics everything fits.
 * `maxVisible` caps the items drawn (the "…" counts as one), as before measuring existed.
 */
export function foldPath(
  segments: readonly PathSegment[],
  avail: number,
  metrics?: PathMetrics,
  maxVisible?: number,
): PathFold {
  const n = segments.length;
  const whole: PathFold = { head: [...segments], hidden: [], tail: [] };
  if (n <= 2) return whole;
  const cap = maxVisible === undefined ? Infinity : Math.max(3, maxVisible);
  const fits = (fold: PathFold): boolean =>
    metrics === undefined || foldWidth(fold, segments, metrics) <= avail + 0.5;
  if (n <= cap && fits(whole)) return whole;
  for (let k = Math.min(n - 2, cap - 2); k >= 1; k -= 1) {
    const fold: PathFold = {
      head: segments.slice(0, 1),
      hidden: segments.slice(1, n - k),
      tail: segments.slice(n - k),
    };
    if (fits(fold)) return fold;
  }
  const rooted: PathFold = {
    head: segments.slice(0, 1),
    hidden: segments.slice(1, n - 1),
    tail: segments.slice(n - 1),
  };
  const current: PathFold = {
    head: [],
    hidden: segments.slice(0, n - 1),
    tail: segments.slice(n - 1),
  };
  return fits(rooted) ? rooted : current;
}

export interface PathBarProps {
  path: string;
  onNavigate: (path: string) => void;
  /** At most this many items (the "…" counts as one); by default only the width limits it. */
  maxVisible?: number;
  class?: string;
}

/**
 * The path bar: a breadcrumb of buttons (`nav` "Path", the last segment is the current
 * location). It shows the full path when it fits; when the bar is narrow the middle folders
 * fold into a "…" menu, and the current folder shrinks with an ellipsis last (UI-010). A
 * changed last segment slides in once. Widths are measured from an invisible copy of every
 * crumb, again on resize and when the web font arrives.
 */
export function PathBar(props: PathBarProps): JSX.Element {
  const [local] = splitProps(props, ['path', 'onNavigate', 'maxVisible', 'class']);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // A signal, not a variable: the "…" button comes and goes, and the menu must anchor to the
  // one on screen (UI-098).
  const [overflowButton, setOverflowButton] = createSignal<HTMLButtonElement>();
  const [avail, setAvail] = createSignal(0);
  const [metrics, setMetrics] = createSignal<PathMetrics>();
  let nav: HTMLElement | undefined;
  let measure: HTMLOListElement | undefined;

  const all = createMemo(() => pathSegments(local.path));
  const layout = createMemo(() => foldPath(all(), avail(), metrics(), local.maxVisible));
  const last = (): PathSegment | undefined => all()[all().length - 1];

  const remeasure = (): void => {
    if (nav === undefined || measure === undefined) return;
    const crumbs = [...measure.querySelectorAll<HTMLElement>('[data-measure="crumb"]')].map(
      (el) => el.getBoundingClientRect().width,
    );
    const sep = measure.querySelector<HTMLElement>('[data-measure="sep"]');
    const dots = measure.querySelector<HTMLElement>('[data-measure="ellipsis"]');
    const gap = Number.parseFloat(getComputedStyle(measure).columnGap);
    setMetrics({
      crumbs,
      separator: sep?.getBoundingClientRect().width ?? 0,
      ellipsis: dots?.getBoundingClientRect().width ?? 0,
      gap: Number.isFinite(gap) ? gap : 0,
    });
    setAvail(nav.clientWidth);
  };

  onMount(() => {
    remeasure();
    if (typeof ResizeObserver !== 'undefined' && nav !== undefined && measure !== undefined) {
      const observer = new ResizeObserver(() => remeasure());
      observer.observe(nav);
      observer.observe(measure);
      onCleanup(() => observer.disconnect());
    }
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts !== undefined && typeof fonts.addEventListener === 'function') {
      fonts.addEventListener('loadingdone', remeasure);
      onCleanup(() => fonts.removeEventListener('loadingdone', remeasure));
    }
  });
  // A new path renders new measuring crumbs first; read them once they are in the document.
  createEffect(on(all, () => remeasure(), { defer: true }));
  createEffect(
    on(
      () => layout().hidden.length,
      (hidden) => {
        if (hidden === 0) setMenuOpen(false);
      },
    ),
  );

  const Segment = (segment: PathSegment): JSX.Element => {
    const current = (): boolean => segment.path === last()?.path;
    return (
      <li class={cx(styles.crumb, current() && styles.crumbLast)}>
        <button
          type="button"
          class={cx(styles.crumbButton, current() && styles.crumbCurrent)}
          aria-current={current() ? 'location' : undefined}
          title={segment.path}
          onClick={() => local.onNavigate(segment.path)}
        >
          {segment.label}
        </button>
      </li>
    );
  };
  const Separator = (): JSX.Element => (
    <li class={styles.crumbSep} aria-hidden="true">
      <ChevronRight size={12} stroke-width={2} />
    </li>
  );

  return (
    <nav ref={(el) => (nav = el)} aria-label="Path" class={cx(styles.pathBar, local.class)}>
      <ol class={styles.crumbs}>
        <For each={layout().head}>
          {(segment, i) => (
            <>
              <Show when={i() > 0}>
                <Separator />
              </Show>
              {Segment(segment)}
            </>
          )}
        </For>
        <Show when={layout().hidden.length > 0}>
          <Show when={layout().head.length > 0}>
            <Separator />
          </Show>
          <li class={styles.crumb}>
            <button
              ref={setOverflowButton}
              type="button"
              class={cx(styles.crumbButton, styles.crumbMore)}
              aria-label={`${layout().hidden.length} more ${layout().hidden.length === 1 ? 'folder' : 'folders'}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              onClick={() => setMenuOpen(!menuOpen())}
            >
              …
            </button>
          </li>
        </Show>
        <For each={layout().tail}>
          {(segment) => (
            <>
              <Separator />
              {Segment(segment)}
            </>
          )}
        </For>
      </ol>
      {/* Every crumb at its natural width, for the fold above; never seen, never focused. */}
      <ol ref={(el) => (measure = el)} class={cx(styles.crumbs, styles.measure)} aria-hidden="true">
        <Index each={all()}>
          {(segment, i) => (
            <li class={styles.crumb}>
              <span
                data-measure="crumb"
                class={cx(styles.crumbButton, i === all().length - 1 && styles.crumbCurrent)}
              >
                {segment().label}
              </span>
            </li>
          )}
        </Index>
        <li class={styles.crumbSep} data-measure="sep">
          <ChevronRight size={12} stroke-width={2} />
        </li>
        <li class={styles.crumb}>
          <span data-measure="ellipsis" class={cx(styles.crumbButton, styles.crumbMore)}>
            …
          </span>
        </li>
      </ol>
      <Menu
        open={menuOpen() && layout().hidden.length > 0}
        anchor={overflowButton()}
        label="Hidden folders"
        items={layout().hidden.map((s) => ({ id: s.path, label: s.label }))}
        onSelect={(path) => local.onNavigate(path)}
        onClose={() => setMenuOpen(false)}
      />
    </nav>
  );
}
