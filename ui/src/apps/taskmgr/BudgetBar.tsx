import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import styles from './BudgetBar.module.css';
import { formatMB, ratio } from './format.ts';
import type { BudgetSegment } from './models.ts';

export interface BudgetBarProps {
  segments: readonly BudgetSegment[];
  budgetBytes: number;
  /** Watermarks as ratios of the budget (0.75, 0.85). */
  lowWatermark: number;
  highWatermark: number;
  /** Greyed while the figures are stale. */
  stale?: boolean;
  /** Spoken summary, e.g. "231 of 256 MB accounted, 90%, above high watermark". */
  valueText: string;
  /** Clicking a segment filters the table to that category. */
  onSegmentClick?: (segment: BudgetSegment) => void;
  class?: string;
}

interface Placed {
  segment: BudgetSegment;
  start: number;
  size: number;
}

/**
 * The stacked memory-budget bar: one full-width layer per segment, placed with translateX and
 * sized with scaleX from its left edge, so a new sample animates without layout. The
 * speculative segment is hatched (never colour alone); its hatch tile is counter-scaled so the
 * stripes stay at 45°. Segments are a list reachable with ←/→, each with its tooltip on focus.
 */
export function BudgetBar(props: BudgetBarProps): JSX.Element {
  const [local] = splitProps(props, [
    'segments',
    'budgetBytes',
    'lowWatermark',
    'highWatermark',
    'stale',
    'valueText',
    'onSegmentClick',
    'class',
  ]);
  const uid = createUniqueId();
  const [active, setActive] = createSignal<number>();
  const [focusIndex, setFocusIndex] = createSignal(0);
  const refs: HTMLElement[] = [];

  const placed = createMemo<Placed[]>(() => {
    let start = 0;
    return local.segments.map((segment) => {
      const size = ratio(segment.bytes, local.budgetBytes);
      const item = { segment, start, size: Math.min(size, Math.max(0, 1 - start)) };
      start += item.size;
      return item;
    });
  });
  const used = (): number => local.segments.reduce((sum, s) => sum + s.bytes, 0);

  const tooltip = createMemo(() => {
    const index = active();
    return index === undefined ? undefined : placed()[index];
  });

  const describe = (segment: BudgetSegment): string =>
    [segment.label, formatMB(segment.bytes), segment.tag]
      .filter((p) => p !== undefined)
      .join(' · ');

  /** In-bar text: the full description when it fits, the name when it barely fits, else none. */
  const labelFor = (item: Placed): string | undefined => {
    if (item.size > 0.2) return describe(item.segment);
    if (item.size > 0.06) return item.segment.label;
    return undefined;
  };

  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const count = placed().length;
    if (event.key === 'Enter' || event.key === ' ') {
      const segment = placed()[index]?.segment;
      if (segment !== undefined) local.onSegmentClick?.(segment);
      event.preventDefault();
      return;
    }
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % count;
    else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    setFocusIndex(next);
    refs[next]?.focus();
  };

  return (
    <div class={cx(styles.root, local.stale === true && styles.stale, local.class)}>
      <div class={styles.ticks} aria-hidden="true">
        <span class={styles.tick} style={{ '--pl-at': String(local.lowWatermark) }}>
          <span class={styles.tickLabel}>LOW {Math.round(local.lowWatermark * 100)}%</span>
        </span>
        <span
          class={cx(styles.tick, styles.tickHigh)}
          style={{ '--pl-at': String(local.highWatermark) }}
        >
          <span class={styles.tickLabel}>HIGH {Math.round(local.highWatermark * 100)}%</span>
        </span>
      </div>
      <div
        class={styles.meter}
        role="meter"
        aria-label="Memory budget"
        aria-valuemin={0}
        aria-valuemax={Math.round(local.budgetBytes / 1048576)}
        aria-valuenow={Math.round(used() / 1048576)}
        aria-valuetext={local.valueText}
      >
        <div class={styles.track}>
          <For each={placed()}>
            {(item) => (
              <span
                class={cx(styles.fill, styles[item.segment.kind])}
                style={{ '--pl-start': String(item.start), '--pl-size': String(item.size) }}
                aria-hidden="true"
              />
            )}
          </For>
          <div class={styles.labels} aria-hidden="true">
            <For each={placed()}>
              {(item) => (
                <span
                  class={styles.label}
                  style={{ '--pl-start': String(item.start), '--pl-size': String(item.size) }}
                >
                  <Show when={labelFor(item)}>
                    {(text) => <span class={styles.chip}>{text()}</span>}
                  </Show>
                </span>
              )}
            </For>
          </div>
          <span
            class={cx(styles.mark, styles.markHigh)}
            style={{ '--pl-at': String(local.highWatermark) }}
            aria-hidden="true"
          />
          <span
            class={styles.mark}
            style={{ '--pl-at': String(local.lowWatermark) }}
            aria-hidden="true"
          />
        </div>
      </div>
      <ul class={styles.segments} role="list" aria-label="Memory by category">
        <For each={placed()}>
          {(item, index) => (
            <li
              ref={(el) => (refs[index()] = el)}
              class={styles.segmentKey}
              tabindex={index() === focusIndex() ? 0 : -1}
              aria-describedby={active() === index() ? `pl-bb-${uid}` : undefined}
              onFocus={() => {
                setFocusIndex(index());
                setActive(index());
              }}
              onBlur={() => setActive(undefined)}
              onPointerEnter={() => setActive(index())}
              onPointerLeave={() => setActive(undefined)}
              onClick={() => local.onSegmentClick?.(item.segment)}
              onKeyDown={(event) => onKeyDown(event, index())}
            >
              <span class={cx(styles.swatch, styles[item.segment.kind])} aria-hidden="true" />
              <span>
                {item.segment.label} <strong>{formatMB(item.segment.bytes)}</strong>
              </span>
              <Show when={item.segment.tag}>
                {(tag) => (
                  <span class={cx(styles.tag, styles[`tag-${item.segment.kind}`])}>{tag()}</span>
                )}
              </Show>
            </li>
          )}
        </For>
        <li class={styles.segmentKey}>
          <span class={cx(styles.swatch, styles.free)} aria-hidden="true" />
          <span>
            Free <strong>{formatMB(Math.max(0, local.budgetBytes - used()))}</strong>
          </span>
        </li>
      </ul>
      <Show when={tooltip()}>
        {(item) => (
          <div
            id={`pl-bb-${uid}`}
            role="tooltip"
            class={styles.tooltip}
            style={{ '--pl-at': String(item().start + item().size / 2) }}
          >
            <strong>{describe(item().segment)}</strong>
            <Show when={item().segment.detail}>
              {(detail) => <span class={styles.tooltipDetail}>{detail()}</span>}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
