import Monitor from 'lucide-solid/icons/monitor';
import Moon from 'lucide-solid/icons/moon';
import Sun from 'lucide-solid/icons/sun';
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { AtomLogo } from '../src/icons/index.tsx';
import { EmptyState } from '../src/primitives/empty-state/EmptyState.tsx';
import { SegmentedControl } from '../src/primitives/segmented-control/SegmentedControl.tsx';
import { SidebarList } from '../src/primitives/sidebar/SidebarList.tsx';
import { Toggle } from '../src/primitives/toggle/Toggle.tsx';
import styles from './gallery.module.css';
import { pagesByGroup, PAGES } from './registry.ts';

type Theme = 'system' | 'light' | 'dark';

interface GalleryState {
  page: string;
  theme: Theme;
  reduceMotion: boolean;
  reduceTransparency: boolean;
}

/** State lives in the URL hash (#/<page>?theme=dark&motion=reduce&transparency=reduce), so a view is shareable. */
function readHash(): GalleryState {
  const raw = location.hash.replace(/^#\/?/u, '');
  const [path = '', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const theme = params.get('theme');
  return {
    page: path === '' ? (PAGES[0]?.id ?? '') : path,
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    reduceMotion: params.get('motion') === 'reduce',
    reduceTransparency: params.get('transparency') === 'reduce',
  };
}

function writeHash(state: GalleryState): void {
  const params = new URLSearchParams();
  if (state.theme !== 'system') params.set('theme', state.theme);
  if (state.reduceMotion) params.set('motion', 'reduce');
  if (state.reduceTransparency) params.set('transparency', 'reduce');
  const query = params.toString();
  const next = `#/${state.page}${query === '' ? '' : `?${query}`}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

const THEMES = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const;

/** The gallery frame: glass sidebar of pages, a window with the theme and accessibility toggles. */
export function GalleryApp(): JSX.Element {
  const [state, setState] = createSignal<GalleryState>(readHash());
  const page = createMemo(() => PAGES.find((p) => p.id === state().page) ?? PAGES[0]);
  let content: HTMLElement | undefined;

  onMount(() => {
    const onHash = (): void => {
      setState(readHash());
    };
    window.addEventListener('hashchange', onHash);
    onCleanup(() => window.removeEventListener('hashchange', onHash));
  });

  createEffect(() => {
    const s = state();
    writeHash(s);
    const root = document.documentElement;
    if (s.theme === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = s.theme;
    if (s.reduceMotion) root.dataset.motion = 'reduce';
    else root.removeAttribute('data-motion');
    if (s.reduceTransparency) root.dataset.transparency = 'reduce';
    else root.removeAttribute('data-transparency');
    document.title = `${page()?.title ?? 'Gallery'} · Plotinium UI`;
  });

  const update = (patch: Partial<GalleryState>): void => {
    setState((s) => ({ ...s, ...patch }));
  };

  const sections = createMemo(() =>
    pagesByGroup(PAGES).map((g) => ({
      id: g.group,
      title: g.group,
      items: g.pages.map((p) => ({ id: p.id, label: p.title })),
    })),
  );

  return (
    <div class={styles.app}>
      <a
        class={styles.skip}
        href="#gallery-content"
        onClick={(e) => {
          e.preventDefault();
          content?.focus();
        }}
      >
        Skip to content
      </a>
      <SidebarList
        label="Gallery pages"
        inset
        class={styles.sidebar}
        sections={sections()}
        selected={page()?.id}
        onSelect={(id) => {
          update({ page: id });
          content?.scrollTo({ top: 0 });
        }}
        header={
          <div class={styles.brand}>
            <AtomLogo size={28} />
            <span class={styles.brandText}>
              <span class={styles.brandName}>Plotinium UI</span>
              <span class={styles.brandSub}>Component gallery</span>
            </span>
          </div>
        }
      />
      <div class={styles.main}>
        <div class={styles.window}>
          <div class={styles.toolbar} role="toolbar" aria-label="Preview settings">
            <h1 class={styles.toolbarTitle}>{page()?.title ?? 'Gallery'}</h1>
            <SegmentedControl
              label="Theme"
              size="sm"
              options={THEMES}
              value={state().theme}
              onChange={(theme) => update({ theme })}
            />
            <Toggle
              size="sm"
              label="Reduce motion"
              checked={state().reduceMotion}
              onChange={(reduceMotion) => update({ reduceMotion })}
            />
            <Toggle
              size="sm"
              label="Reduce transparency"
              checked={state().reduceTransparency}
              onChange={(reduceTransparency) => update({ reduceTransparency })}
            />
          </div>
          <main
            id="gallery-content"
            class={styles.content}
            tabindex={-1}
            ref={(el) => (content = el)}
          >
            <Show
              when={page()}
              fallback={
                <EmptyState
                  title="No gallery pages yet"
                  description="Add a file to ui/gallery/pages/."
                />
              }
            >
              {(current) => <Dynamic component={current().component} />}
            </Show>
          </main>
        </div>
      </div>
    </div>
  );
}
