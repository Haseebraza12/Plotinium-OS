import { createSignal, For, onMount, type JSX } from 'solid-js';

import { AppIcon, AtomLogo, type IconId } from '../../src/icons/index.tsx';
import { Table, type TableColumn } from '../../src/primitives/table/Table.tsx';
import { Caption, Demo, Grid, Page, Section, Stage, ThemeSplit } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './tokens.module.css';

export const meta: GalleryPageMeta = {
  id: 'tokens',
  title: 'Tokens',
  group: 'Foundations',
  order: 0,
  description:
    'Colour roles, materials, shape, elevation, spacing, type, layers and icons from tokens.css.',
};

const COLOUR_GROUPS: readonly { title: string; tokens: readonly string[] }[] = [
  {
    title: 'Labels',
    tokens: ['--pl-text', '--pl-text-muted', '--pl-text-tertiary', '--pl-text-disabled'],
  },
  {
    title: 'Accent',
    tokens: [
      '--pl-accent',
      '--pl-accent-hover',
      '--pl-accent-pressed',
      '--pl-accent-text',
      '--pl-accent-subtle',
      '--pl-focus-color',
    ],
  },
  {
    title: 'Status',
    tokens: [
      '--pl-success',
      '--pl-success-subtle',
      '--pl-warning',
      '--pl-warning-subtle',
      '--pl-danger',
      '--pl-danger-subtle',
      '--pl-danger-fill',
      '--pl-info',
      '--pl-info-subtle',
    ],
  },
  {
    title: 'Surfaces',
    tokens: ['--pl-bg', '--pl-surface', '--pl-surface-2', '--pl-surface-3', '--pl-scrim'],
  },
  {
    title: 'Lines',
    tokens: ['--pl-hairline', '--pl-separator', '--pl-border-subtle', '--pl-border'],
  },
  {
    title: 'Controls',
    tokens: [
      '--pl-control-bg',
      '--pl-control-hover',
      '--pl-control-pressed',
      '--pl-control-raised',
      '--pl-toggle-off',
      '--pl-selection',
      '--pl-selection-idle',
    ],
  },
  {
    title: 'Tints',
    tokens: [
      '--pl-tint-indigo',
      '--pl-tint-blue',
      '--pl-tint-teal',
      '--pl-tint-green',
      '--pl-tint-yellow',
      '--pl-tint-orange',
      '--pl-tint-red',
      '--pl-tint-pink',
      '--pl-tint-purple',
      '--pl-tint-gray',
    ],
  },
  {
    title: 'Window controls',
    tokens: [
      '--pl-traffic-close',
      '--pl-traffic-minimise',
      '--pl-traffic-zoom',
      '--pl-traffic-idle',
    ],
  },
];

const MATERIALS: readonly {
  name: string;
  class: string | undefined;
  recipe: string;
  live: boolean;
}[] = [
  {
    name: 'Menu bar',
    class: styles.menubar,
    recipe: 'glass-menubar · blur 30 · sat 180%',
    live: true,
  },
  { name: 'Dock', class: styles.dock, recipe: 'glass-dock · blur 40 · sat 190%', live: true },
  {
    name: 'Window (static)',
    class: styles.window,
    recipe: 'glass-window · tint only',
    live: false,
  },
  {
    name: 'Sidebar (vibrancy)',
    class: styles.sidebar,
    recipe: 'glass-sidebar · tint only',
    live: false,
  },
  { name: 'Popover / menu', class: styles.popover, recipe: 'glass-popover · blur 30', live: true },
  { name: 'Sheet', class: styles.sheet, recipe: 'glass-sheet · blur 40', live: true },
  { name: 'HUD', class: styles.hud, recipe: 'glass-hud · blur 24', live: true },
  { name: 'Card', class: styles.card, recipe: 'glass-card · tint only', live: false },
];

const RADII = ['xs', 'sm', 'ctl', 'md', 'lg', 'win', 'sheet', 'dock', 'pill'] as const;
const SHADOWS = [
  ['--pl-shadow-win-focus', 'Window · focused'],
  ['--pl-shadow-win', 'Window · unfocused'],
  ['--pl-shadow-win-drag', 'Window · dragging'],
  ['--pl-shadow-pop', 'Popover, menu'],
  ['--pl-shadow-dialog', 'Dialog, sheet'],
  ['--pl-shadow-dock', 'Dock'],
  ['--pl-shadow-tooltip', 'Tooltip'],
] as const;
const SPACES = ['half', '1', '2', '3', '4', '5', '6', '8', '10', '12'] as const;
const TYPE_ROLES = [
  ['display', 'Display', '10:42'],
  ['large-title', 'Large title', 'Privacy & AI'],
  ['title', 'Title', 'Confirm destructive plan'],
  ['headline', 'Headline', 'Keep telemetry on this device'],
  ['body', 'Body', 'Plotinium uses a multilevel feedback queue with 32 priority levels.'],
  ['callout', 'Callout', 'Rebuild index'],
  ['caption', 'Caption', '3,118 of 3,530 chunks indexed · ai.indexer pid 23'],
  ['section', 'Section', 'FAVOURITES'],
  ['mono', 'Mono', 'student@plotinium:~$ ls -la'],
] as const;
const LAYERS = [
  '--pl-z-desktop',
  '--pl-z-windows',
  '--pl-z-snap-preview',
  '--pl-z-dock',
  '--pl-z-menubar',
  '--pl-z-overview',
  '--pl-z-dialog',
  '--pl-z-popover',
  '--pl-z-search',
  '--pl-z-notify',
  '--pl-z-hud',
  '--pl-z-meter',
  '--pl-z-tooltip',
  '--pl-z-secure',
  '--pl-z-boot',
] as const;
const APP_ICONS: readonly IconId[] = [
  'files',
  'terminal',
  'editor',
  'task-manager',
  'settings',
  'search',
  'trash',
  'trash-full',
];

function Swatches(): JSX.Element {
  return (
    <For each={COLOUR_GROUPS}>
      {(group) => (
        <>
          <span class={styles.groupLabel}>{group.title}</span>
          <div class={styles.swatches}>
            <For each={group.tokens}>
              {(token) => (
                <div class={styles.swatch}>
                  <span class={`${styles.chip ?? ''} ${styles.chipOnSurface ?? ''}`}>
                    <span
                      class={styles.chip}
                      style={{ display: 'block', background: `var(${token})` }}
                    />
                  </span>
                  <span class={styles.swatchName}>{token.replace('--pl-', '')}</span>
                </div>
              )}
            </For>
          </div>
        </>
      )}
    </For>
  );
}

interface LayerRow {
  token: string;
  value: string;
}

export default function TokensPage(): JSX.Element {
  const [layers, setLayers] = createSignal<readonly LayerRow[]>(
    LAYERS.map((token) => ({ token, value: '' })),
  );
  onMount(() => {
    const computed = getComputedStyle(document.documentElement);
    setLayers(LAYERS.map((token) => ({ token, value: computed.getPropertyValue(token).trim() })));
  });
  const layerColumns: readonly TableColumn<LayerRow>[] = [
    { id: 'token', header: 'Token', cell: (r) => r.token, mono: true, width: 'minmax(0, 2fr)' },
    { id: 'value', header: 'z-index', cell: (r) => r.value, align: 'end', width: '96px' },
  ];

  return (
    <Page
      title="Tokens"
      lead="Every colour, material, radius, shadow, spacing step, type role, layer and duration used by Plotinium comes from ui/src/tokens/tokens.css. Components never use raw values (DSN-02)."
    >
      <Section
        title="Colour roles"
        lead="Both themes side by side. The accent is violet: #5856D6 in light, #5E5CE6 in dark."
      >
        <ThemeSplit>{() => <Swatches />}</ThemeSplit>
      </Section>

      <Section
        title="Materials"
        lead="Live glass (backdrop-filter) is reserved for the menu bar, dock, popovers and menus, Control Centre, notifications, Search, sheets and HUDs. Windows and sidebars use a static tint so ten windows hold 60 fps."
      >
        <Stage>
          <div class={styles.materials}>
            <For each={MATERIALS}>
              {(material) => (
                <div class={`${styles.material ?? ''} ${material.class ?? ''}`}>
                  <span class={styles.materialName}>{material.name}</span>
                  <span class={styles.materialRecipe}>{material.recipe}</span>
                  <Caption>{material.live ? 'Live blur' : 'No blur'}</Caption>
                </div>
              )}
            </For>
          </div>
        </Stage>
      </Section>

      <Section title="Radii">
        <div class={styles.boxes}>
          <For each={RADII}>
            {(r) => (
              <div class={styles.box} style={{ 'border-radius': `var(--pl-radius-${r})` }}>
                {r}
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section
        title="Elevation"
        lead="Window shadows come in three tiers. Dragging drops to the light tier so a moving window repaints less."
      >
        <Stage>
          <div class={styles.boxes}>
            <For each={SHADOWS}>
              {([token, label]) => (
                <div class={styles.shadowBox} style={{ 'box-shadow': `var(${token})` }}>
                  {label}
                </div>
              )}
            </For>
          </div>
        </Stage>
      </Section>

      <Grid min={320}>
        <Demo title="Spacing" note="4-pt scale" column>
          <div class={styles.space}>
            <For each={SPACES}>
              {(step) => (
                <>
                  <code class={styles.swatchName}>space-{step}</code>
                  <span class={styles.spaceBar} style={{ width: `var(--pl-space-${step})` }} />
                </>
              )}
            </For>
          </div>
        </Demo>
        <Demo title="Layers" note="z-index, bottom to top" column>
          <Table
            label="Layers"
            columns={layerColumns}
            rows={layers()}
            rowId={(r) => r.token}
            selectionMode="none"
            density="compact"
          />
        </Demo>
      </Grid>

      <Section
        title="Type"
        lead="Inter 4 (variable, with optical sizes) and JetBrains Mono (variable), self-hosted under the OFL. Text is never below 12 px."
      >
        <div>
          <For each={TYPE_ROLES}>
            {([role, label, sample]) => (
              <div class={styles.typeRow}>
                <code class={styles.swatchName}>
                  {label} · type-{role}
                </code>
                <span class={styles.typeSample} style={{ font: `var(--pl-type-${role})` }}>
                  {sample}
                </span>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section
        title="Icons"
        lead="The Bohr P mark (an atom that is also the P of Plotinium) and our own rounded-square app icons, legible from 16 px to 256 px."
      >
        <Stage>
          <div class={styles.iconRow}>
            <For each={[16, 24, 32, 64, 128, 256]}>
              {(size) => (
                <div class={styles.iconCell}>
                  <AtomLogo size={size} label={size === 256 ? 'Plotinium' : undefined} />
                  <Caption>{size}</Caption>
                </div>
              )}
            </For>
          </div>
        </Stage>
        <Stage>
          <div class={styles.iconRow}>
            <For each={APP_ICONS}>
              {(id) => (
                <div class={styles.iconCell}>
                  <AppIcon app={id} size={64} />
                  <AppIcon app={id} size={32} />
                  <AppIcon app={id} size={16} />
                  <Caption>{id}</Caption>
                </div>
              )}
            </For>
          </div>
        </Stage>
      </Section>
    </Page>
  );
}
