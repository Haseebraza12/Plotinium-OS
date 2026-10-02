import Clock3 from 'lucide-solid/icons/clock-3';
import Download from 'lucide-solid/icons/download';
import FileText from 'lucide-solid/icons/file-text';
import HardDrive from 'lucide-solid/icons/hard-drive';
import House from 'lucide-solid/icons/house';
import Server from 'lucide-solid/icons/server';
import Trash2 from 'lucide-solid/icons/trash-2';
import Usb from 'lucide-solid/icons/usb';
import { createMemo, createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import type { IconComponent } from '../../primitives/internal/icon.ts';
import { ProgressBar, type ProgressTone } from '../../primitives/progress/ProgressBar.tsx';
import { SidebarList, type SidebarSection } from '../../primitives/sidebar/SidebarList.tsx';
import styles from './Files.module.css';
import { quotaLevel, quotaText } from './format.ts';
import type { FileTag, Place, PlaceIcon, Quota } from './types.ts';

const PLACE_ICONS: Record<PlaceIcon, IconComponent> = {
  home: House,
  documents: FileText,
  downloads: Download,
  recent: Clock3,
  trash: Trash2,
  root: HardDrive,
  tmp: Server,
  mnt: Usb,
};

export interface FilesSidebarProps {
  favourites: readonly Place[];
  locations: readonly Place[];
  tags: readonly FileTag[];
  selectedPlace?: string;
  onPlace: (id: string) => void;
  /** Tag ids filtering the view (aria-pressed). */
  activeTags?: ReadonlySet<string>;
  onToggleTag?: (id: string) => void;
  quota?: Quota;
  /** Leave room at the top for the window's traffic lights (unified toolbar). */
  titlebarInset?: boolean;
}

const TONE: Record<ReturnType<typeof quotaLevel>, ProgressTone> = {
  normal: 'accent',
  warning: 'warning',
  danger: 'danger',
};

/** Words for the quota state, so the level is never colour alone (DSN-08). */
export function quotaStateText(quota: Quota): string | undefined {
  switch (quotaLevel(quota)) {
    case 'normal':
      return undefined;
    case 'warning':
      return 'Nearly full';
    case 'danger':
      return 'Quota full soon';
  }
}

/**
 * The Files source list (vibrancy material as a static tint): Favourites and Locations as
 * navigation, Tags as filter toggles whose colour dot always sits next to the tag's name, and
 * the quota meter at the foot.
 */
export function FilesSidebar(props: FilesSidebarProps): JSX.Element {
  const [local] = splitProps(props, [
    'favourites',
    'locations',
    'tags',
    'selectedPlace',
    'onPlace',
    'activeTags',
    'onToggleTag',
    'quota',
    'titlebarInset',
  ]);
  const tagsId = `pl-files-tags-${createUniqueId()}`;
  const sections = createMemo((): SidebarSection[] => [
    {
      id: 'favourites',
      title: 'Favourites',
      items: local.favourites.map((p) => ({ id: p.id, label: p.label, icon: PLACE_ICONS[p.icon] })),
    },
    {
      id: 'locations',
      title: 'Locations',
      items: local.locations.map((p) => ({
        id: p.id,
        label: p.unmounted === true ? `${p.label} (not mounted)` : p.label,
        icon: PLACE_ICONS[p.icon],
        disabled: p.unmounted === true,
      })),
    },
  ]);

  return (
    <SidebarList
      label="Places"
      class={cx(styles.sidebar, local.titlebarInset === true && styles.sidebarInset)}
      sections={sections()}
      selected={local.selectedPlace}
      onSelect={(id) => local.onPlace(id)}
      accentSelection
      footer={
        <div class={styles.sidebarFoot}>
          <Show when={local.tags.length > 0}>
            <div role="group" aria-labelledby={tagsId} class={styles.tagGroup}>
              <h3 id={tagsId} class={styles.sectionTitle}>
                Tags
              </h3>
              <ul class={styles.tagList}>
                <For each={local.tags}>
                  {(tag) => (
                    <li>
                      <button
                        type="button"
                        class={styles.tag}
                        aria-pressed={local.activeTags?.has(tag.id) === true}
                        onClick={() => local.onToggleTag?.(tag.id)}
                      >
                        <span
                          class={styles.tagDot}
                          style={{ background: `var(--pl-tint-${tag.tint})` }}
                          aria-hidden="true"
                        />
                        {tag.label}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={local.quota}>
            {(quota) => (
              <div class={styles.quota}>
                <ProgressBar
                  size="sm"
                  label="Storage"
                  value={quota().used}
                  max={quota().total}
                  valueText={`${quotaText(quota())} used${quotaStateText(quota()) === undefined ? '' : `, ${quotaStateText(quota()) ?? ''}`}`}
                  tone={TONE[quotaLevel(quota())]}
                  hideLabel
                />
                <span class={styles.quotaText}>
                  {quotaText(quota())}
                  <Show when={quotaStateText(quota())}>
                    {(state) => <strong class={styles.quotaState}> · {state()}</strong>}
                  </Show>
                </span>
              </div>
            )}
          </Show>
        </div>
      }
    />
  );
}
