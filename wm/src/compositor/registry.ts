/**
 * The window registry and the stacking order (window-manager.md §3.3, WMD-03).
 *
 * The mandated structures are the team's `dsa/hashtable` (the WindowRegistry, keyed by wid, O(1)
 * average, WM-01) and `dsa/zorder` (a linked list with O(1) raise). The compositor codes against
 * the two small interfaces below and switches on each structure's IMPLEMENTED flag; while a flag
 * is false it uses the stand-ins (a Map, a bottom-to-top array).
 * TODO(dsa/hashtable, dsa/zorder): delete the stand-ins once both flags are permanently true.
 */
import type { IntHashTable, ZOrderList } from '@plotinium/dsa';
import {
  HASHTABLE_IMPLEMENTED,
  LinkedZOrder,
  OpenAddressingTable,
  ZORDER_IMPLEMENTED,
} from '@plotinium/dsa';

export interface WindowTable<W> {
  get(wid: number): W | undefined;
  set(wid: number, w: W): void;
  delete(wid: number): boolean;
  has(wid: number): boolean;
  readonly size: number;
  values(): W[];
}

/** Stand-in. TODO(dsa/hashtable). */
export class MapWindowTable<W> implements WindowTable<W> {
  private readonly map = new Map<number, W>();
  get(wid: number): W | undefined {
    return this.map.get(wid);
  }
  set(wid: number, w: W): void {
    this.map.set(wid, w);
  }
  delete(wid: number): boolean {
    return this.map.delete(wid);
  }
  has(wid: number): boolean {
    return this.map.has(wid);
  }
  get size(): number {
    return this.map.size;
  }
  values(): W[] {
    return [...this.map.values()];
  }
}

export class HashWindowTable<W> implements WindowTable<W> {
  private readonly table: IntHashTable<W>;
  constructor(table: IntHashTable<W>) {
    this.table = table;
  }
  get(wid: number): W | undefined {
    return this.table.get(wid);
  }
  set(wid: number, w: W): void {
    this.table.set(wid, w);
  }
  delete(wid: number): boolean {
    return this.table.delete(wid);
  }
  has(wid: number): boolean {
    return this.table.has(wid);
  }
  get size(): number {
    return this.table.size;
  }
  values(): W[] {
    const out: W[] = [];
    this.table.forEach((w) => out.push(w));
    return out;
  }
}

export function createWindowTable<W>(): WindowTable<W> {
  return HASHTABLE_IMPLEMENTED
    ? new HashWindowTable<W>(new OpenAddressingTable<W>(16))
    : new MapWindowTable<W>();
}

/** Stacking order, bottom to top. z is the 1-based position (renumbered 1..n after each change). */
export interface StackOrder {
  insertTop(wid: number): void;
  /** Directly below the current top (a window opened without user activation, WMD-09). */
  insertBelowTop(wid: number): void;
  remove(wid: number): void;
  raise(wid: number): void;
  zOf(wid: number): number | undefined;
  top(): number | undefined;
  topWhere(pred: (wid: number) => boolean): number | undefined;
  bottomToTop(): number[];
  readonly size: number;
}

/** Stand-in. TODO(dsa/zorder). */
export class ArrayStackOrder implements StackOrder {
  private order: number[] = [];
  get size(): number {
    return this.order.length;
  }
  insertTop(wid: number): void {
    this.order.push(wid);
  }
  insertBelowTop(wid: number): void {
    this.order.splice(Math.max(0, this.order.length - 1), 0, wid);
  }
  remove(wid: number): void {
    this.order = this.order.filter((w) => w !== wid);
  }
  raise(wid: number): void {
    if (this.order[this.order.length - 1] === wid || !this.order.includes(wid)) return;
    this.remove(wid);
    this.order.push(wid);
  }
  zOf(wid: number): number | undefined {
    const i = this.order.indexOf(wid);
    return i < 0 ? undefined : i + 1;
  }
  top(): number | undefined {
    return this.order[this.order.length - 1];
  }
  topWhere(pred: (wid: number) => boolean): number | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const wid = this.order[i];
      if (wid !== undefined && pred(wid)) return wid;
    }
    return undefined;
  }
  bottomToTop(): number[] {
    return [...this.order];
  }
}

/** Adapter over the team's `dsa/zorder` list. */
export class ZOrderStack implements StackOrder {
  private readonly list: ZOrderList;
  constructor(list: ZOrderList) {
    this.list = list;
  }
  get size(): number {
    return this.list.size;
  }
  insertTop(wid: number): void {
    this.list.insertTop(wid);
  }
  insertBelowTop(wid: number): void {
    const top = this.list.top();
    this.list.insertTop(wid);
    if (top !== undefined) this.list.raise(top);
  }
  remove(wid: number): void {
    if (this.list.zOf(wid) !== undefined) this.list.remove(wid);
  }
  raise(wid: number): void {
    if (this.list.zOf(wid) !== undefined) this.list.raise(wid);
  }
  zOf(wid: number): number | undefined {
    return this.list.zOf(wid);
  }
  top(): number | undefined {
    return this.list.top();
  }
  topWhere(pred: (wid: number) => boolean): number | undefined {
    return this.list.topWhere(pred);
  }
  bottomToTop(): number[] {
    return this.list.bottomToTop();
  }
}

export function createStackOrder(): StackOrder {
  return ZORDER_IMPLEMENTED ? new ZOrderStack(new LinkedZOrder(16)) : new ArrayStackOrder();
}
