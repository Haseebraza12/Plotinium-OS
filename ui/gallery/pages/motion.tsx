import { createSignal, For, type JSX } from 'solid-js';

import { AppIcon, AtomLogo } from '../../src/icons/index.tsx';
import { Avatar } from '../../src/primitives/avatar/Avatar.tsx';
import { Button } from '../../src/primitives/button/Button.tsx';
import { ProgressBar } from '../../src/primitives/progress/ProgressBar.tsx';
import { Table, type TableColumn } from '../../src/primitives/table/Table.tsx';
import { Toggle } from '../../src/primitives/toggle/Toggle.tsx';
import { Demo, Grid, Page, Replay, Row, Section } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './motion.module.css';

export const meta: GalleryPageMeta = {
  id: 'motion',
  title: 'Motion',
  group: 'Foundations',
  order: 1,
  description: 'Every animation class in motion.css, replayable, with its reduced-motion fallback.',
};

interface MotionRow {
  element: string;
  trigger: string;
  className: string;
  duration: string;
  easing: string;
  reduced: string;
}

/** Mirrors the motion table in specs/05-wm/visual-language-macos.md §3.7. */
const MOTION: readonly MotionRow[] = [
  {
    element: 'Window',
    trigger: 'open',
    className: 'pl-anim-window-open',
    duration: '360 ms',
    easing: 'spring',
    reduced: 'appears',
  },
  {
    element: 'Window',
    trigger: 'close',
    className: 'pl-anim-window-close',
    duration: '160 ms',
    easing: 'ease-in',
    reduced: 'disappears',
  },
  {
    element: 'Window',
    trigger: 'minimise (genie)',
    className: 'pl-anim-window-minimise',
    duration: 'slow 320 ms',
    easing: 'genie',
    reduced: 'disappears',
  },
  {
    element: 'Window',
    trigger: 'restore from dock',
    className: 'pl-anim-window-restore',
    duration: 'slow 320 ms',
    easing: 'spring',
    reduced: 'appears',
  },
  {
    element: 'Window',
    trigger: 'maximise / restore',
    className: 'pl-anim-window-maximise',
    duration: '260 ms',
    easing: 'spring',
    reduced: 'jumps',
  },
  {
    element: 'Window',
    trigger: 'focus change',
    className: 'pl-focus-shadow',
    duration: 'med 200 ms',
    easing: 'standard',
    reduced: 'instant',
  },
  {
    element: 'Menu',
    trigger: 'open / close',
    className: 'pl-anim-menu-in / -out',
    duration: '140 / 100 ms',
    easing: 'ease-out / in',
    reduced: 'instant',
  },
  {
    element: 'Popover',
    trigger: 'open / close',
    className: 'pl-anim-popover-in / -out',
    duration: '180 / 100 ms',
    easing: 'soft spring',
    reduced: 'instant',
  },
  {
    element: 'Sheet',
    trigger: 'open / close',
    className: 'pl-anim-sheet-in / -out',
    duration: '300 / 180 ms',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Dialog',
    trigger: 'open / close',
    className: 'pl-anim-dialog-in / -out',
    duration: '240 / 140 ms',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Notification',
    trigger: 'arrive / dismiss',
    className: 'pl-anim-notification-in / -out',
    duration: '420 / 220 ms',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Notification stack',
    trigger: 'expand',
    className: 'pl-notification-stack',
    duration: 'slow 320 ms',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Control Centre',
    trigger: 'open',
    className: 'pl-anim-cc-in + pl-anim-cc-tile',
    duration: '240 ms + 20 ms stagger',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Search palette',
    trigger: 'open / close',
    className: 'pl-anim-search-in / -out',
    duration: '220 / 120 ms',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Overview',
    trigger: 'enter',
    className: 'pl-anim-overview-in',
    duration: '360 ms',
    easing: 'spring',
    reduced: 'instant',
  },
  {
    element: 'Dock icon',
    trigger: 'launch',
    className: 'pl-anim-dock-bounce',
    duration: 'xslow 480 ms, once',
    easing: 'spring',
    reduced: 'no bounce',
  },
  {
    element: 'Dock icon',
    trigger: 'needs attention',
    className: 'pl-anim-dock-attention',
    duration: '720 ms, once',
    easing: 'standard',
    reduced: 'badge only',
  },
  {
    element: 'Boot mark',
    trigger: 'splash',
    className: 'pl-anim-boot-glow',
    duration: '900 ms',
    easing: 'ease-out',
    reduced: 'static',
  },
  {
    element: 'Progress bar',
    trigger: 'real progress',
    className: 'pl-anim-progress-sweep',
    duration: '1400 ms × 3',
    easing: 'standard',
    reduced: 'no sheen',
  },
  {
    element: 'Lock screen',
    trigger: 'unlock / wrong password',
    className: 'pl-anim-login-unlock / -shake',
    duration: '420 ms',
    easing: 'ease-in',
    reduced: 'instant; text error',
  },
  {
    element: 'Restored window',
    trigger: 'session restore',
    className: 'pl-anim-restore-shimmer',
    duration: '900 ms, once',
    easing: 'standard',
    reduced: 'none',
  },
  {
    element: 'Toggle knob',
    trigger: 'switch',
    className: 'Toggle (knob transform)',
    duration: 'slow 320 ms',
    easing: 'bouncy spring',
    reduced: 'instant',
  },
];

const COLUMNS: readonly TableColumn<MotionRow>[] = [
  { id: 'element', header: 'Element', cell: (r) => r.element, width: 'minmax(0, 1.1fr)' },
  { id: 'trigger', header: 'Trigger', cell: (r) => r.trigger, width: 'minmax(0, 1.1fr)' },
  { id: 'class', header: 'Class', cell: (r) => r.className, mono: true, width: 'minmax(0, 2fr)' },
  { id: 'duration', header: 'Duration', cell: (r) => r.duration, width: 'minmax(0, 1.2fr)' },
  { id: 'easing', header: 'Easing', cell: (r) => r.easing, width: 'minmax(0, 0.9fr)' },
  {
    id: 'reduced',
    header: 'Reduced motion',
    cell: (r) => r.reduced,
    muted: true,
    width: 'minmax(0, 1fr)',
  },
];

function MockWindow(props: { class?: string; style?: JSX.CSSProperties }): JSX.Element {
  return (
    <div class={`${styles.window ?? ''} ${props.class ?? ''}`} style={props.style}>
      <div class={styles.titlebar}>
        <span class={`${styles.light ?? ''} ${styles.close ?? ''}`} />
        <span class={`${styles.light ?? ''} ${styles.min ?? ''}`} />
        <span class={`${styles.light ?? ''} ${styles.zoom ?? ''}`} />
      </div>
    </div>
  );
}

export default function MotionPage(): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [focused, setFocused] = createSignal(0);
  const [toggle, setToggle] = createSignal(true);
  const [progress, setProgress] = createSignal(42);

  return (
    <Page
      title="Motion"
      lead="Only transform and opacity animate. Springs use CSS linear() with cubic-bezier fallbacks; every class collapses to an instant change under Reduce motion (try the toggle above)."
    >
      <Section title="Windows">
        <Grid min={300}>
          <Demo title="Open and close" note="spring in, ease out">
            <Replay>
              {(n) => (
                <div class={styles.stage}>
                  <MockWindow
                    class={n % 2 === 0 ? 'pl-anim-window-close' : 'pl-anim-window-open'}
                  />
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Minimise (genie)" note="transform-only toward the dock icon">
            <Replay>
              {(n) => (
                <div class={styles.stage}>
                  <MockWindow
                    class={n % 2 === 0 ? 'pl-anim-window-minimise' : 'pl-anim-window-restore'}
                    style={{ '--pl-genie-x': '0px', '--pl-genie-y': '70px' }}
                  />
                  <span class={styles.dockIcon}>
                    <AppIcon app="files" size={28} />
                  </span>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Maximise" note="FLIP from the old frame">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <MockWindow
                    class="pl-anim-window-maximise"
                    style={{
                      '--pl-flip-x': '60px',
                      '--pl-flip-y': '40px',
                      '--pl-flip-sx': '0.6',
                      '--pl-flip-sy': '0.6',
                    }}
                  />
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Focus change" note="shadow crossfade on a pseudo-element">
            <div class={styles.stage}>
              <div class={styles.focusWindows}>
                <For each={[0, 1]}>
                  {(i) => (
                    <button
                      type="button"
                      class={`${styles.focusWindow ?? ''} pl-focus-shadow`}
                      data-focused={focused() === i}
                      aria-pressed={focused() === i}
                      aria-label={`Focus window ${i + 1}`}
                      onClick={() => setFocused(i)}
                    />
                  )}
                </For>
              </div>
            </div>
          </Demo>
        </Grid>
      </Section>

      <Section title="Overlays">
        <Grid min={260}>
          <Demo title="Menu">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={`${styles.panel ?? ''} pl-anim-menu-in`}>
                    New Folder
                    <div class={styles.line} />
                    Get Info
                  </div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Popover">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={`${styles.panel ?? ''} pl-anim-popover-in`}>AI · Connected</div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Sheet drop">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={styles.sheetHost}>
                    <div class={`${styles.sheet ?? ''} pl-anim-sheet-in`} />
                  </div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Search palette" note="scale-in">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={`${styles.search ?? ''} pl-anim-search-in`}>
                    Search apps, files and commands
                  </div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Control Centre" note="panel + staggered tiles">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={`${styles.ccGrid ?? ''} pl-anim-cc-in`}>
                    <For each={[0, 1, 2, 3, 4, 5]}>
                      {(i) => (
                        <div
                          class={`${styles.tile ?? ''} pl-anim-cc-tile`}
                          style={{ '--pl-stagger-index': String(i) }}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Overview zoom">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={`${styles.overview ?? ''} pl-anim-overview-in`}>
                    <For each={[0, 1, 2, 3, 4, 5]}>{() => <div class={styles.thumb} />}</For>
                  </div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Notifications" note="slide in, stack and expand">
            <Replay>
              {() => (
                <div class={styles.stage} style={{ 'place-items': 'start end' }}>
                  <div
                    class={`${styles.notifications ?? ''} pl-notification-stack ${expanded() ? (styles.expanded ?? '') : ''}`}
                    data-expanded={expanded()}
                  >
                    <For each={['Build finished', 'Sync complete', 'ai.indexer idle']}>
                      {(text, i) => (
                        <div
                          class={`${styles.notification ?? ''} pl-anim-notification-in`}
                          style={{ '--pl-stack-index': String(i()), 'z-index': String(3 - i()) }}
                        >
                          {text}
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </Replay>
            <Button size="sm" onClick={() => setExpanded((e) => !e)}>
              {expanded() ? 'Collapse stack' : 'Expand stack'}
            </Button>
          </Demo>
        </Grid>
      </Section>

      <Section title="Dock, boot, login, restore">
        <Grid min={260}>
          <Demo title="Dock bounce" note="once on launch">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <span class="pl-anim-dock-bounce">
                    <AppIcon app="terminal" size={56} />
                  </span>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Boot glow and progress sweep">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={styles.bootColumn}>
                    <span class="pl-anim-boot-glow">
                      <AtomLogo size={72} />
                    </span>
                    <ProgressBar
                      label="Starting services"
                      hideLabel
                      value={progress()}
                      size="sm"
                      sweep
                    />
                  </div>
                </div>
              )}
            </Replay>
            <Button size="sm" onClick={() => setProgress((p) => (p >= 100 ? 10 : p + 18))}>
              Advance progress
            </Button>
          </Demo>
          <Demo title="Login unlock and shake">
            <Replay label="Unlock">
              {(n) => (
                <div class={styles.stage}>
                  <div
                    class={`${styles.login ?? ''} ${n % 2 === 0 ? 'pl-anim-login-shake' : n > 1 ? 'pl-anim-login-unlock' : ''}`}
                  >
                    <Avatar name="student" size="lg" decorative />
                    student
                  </div>
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Restore shimmer" note="once, after session restore">
            <Replay>
              {() => (
                <div class={styles.stage}>
                  <div class={`${styles.restore ?? ''} pl-anim-restore-shimmer`} />
                </div>
              )}
            </Replay>
          </Demo>
          <Demo title="Toggle spring">
            <Row>
              <Toggle label="Reduce transparency" checked={toggle()} onChange={setToggle} />
            </Row>
          </Demo>
        </Grid>
      </Section>

      <Section title="Motion table" lead="Normative in specs/05-wm/visual-language-macos.md §3.7.">
        <Table
          label="Motion table"
          columns={COLUMNS}
          rows={MOTION}
          rowId={(r) => `${r.element}-${r.trigger}`}
          selectionMode="none"
          density="compact"
        />
      </Section>
    </Page>
  );
}
