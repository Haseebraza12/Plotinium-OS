/**
 * The C16 scaffold contract (specs/08-dsa/data-structures.md §3.2, DSA-GEN-08). While a module's
 * IMPLEMENTED flag is false, every public entry point throws NotImplementedError naming the owner;
 * each row below turns itself off when the owner flips the flag, so this file never blocks them.
 */
import { describe, expect, it } from 'vitest';

import { DsaError, NotImplementedError } from '../src/_shared/errors.ts';
import type { OwnerRole } from '../src/_shared/errors.ts';
import * as bloom from '../src/bloom/index.ts';
import * as dag from '../src/dag/index.ts';
import * as hashtable from '../src/hashtable/index.ts';
import * as heap from '../src/heap/index.ts';
import * as lru from '../src/lru/index.ts';
import * as ringbuffer from '../src/ringbuffer/index.ts';
import * as tree from '../src/tree/index.ts';
import * as trie from '../src/trie/index.ts';
import * as zorder from '../src/zorder/index.ts';
import * as dsa from '../src/index.ts';

interface ModuleRow {
  readonly name: string;
  readonly owner: OwnerRole;
  readonly implemented: boolean;
  /** Instances whose every prototype method and getter must throw. */
  readonly instances: () => object[];
  /** Free functions that must throw. */
  readonly calls: ReadonlyArray<() => unknown>;
}

const ROWS: readonly ModuleRow[] = [
  {
    name: 'tree',
    owner: 'R2',
    implemented: tree.IMPLEMENTED,
    instances: () => [],
    calls: [() => tree.createTree('root', null)],
  },
  {
    name: 'trie',
    owner: 'R3',
    implemented: trie.IMPLEMENTED,
    instances: () => [new trie.RadixTrie(), new trie.NamespacedRadixTrie()],
    calls: [],
  },
  {
    name: 'heap',
    owner: 'R1',
    implemented: heap.IMPLEMENTED,
    instances: () => [
      new heap.BinaryHeap(),
      new heap.HeapPriorityQueue<string>(),
      new heap.BoundedTopKHeap(1),
    ],
    calls: [],
  },
  {
    name: 'dag',
    owner: 'R5',
    implemented: dag.IMPLEMENTED,
    instances: () => [],
    calls: [() => dag.buildDag([]), () => dag.topoLevels([])],
  },
  {
    name: 'lru',
    owner: 'R1',
    implemented: lru.IMPLEMENTED,
    instances: () => [new lru.LruCache<string, number>()],
    calls: [],
  },
  {
    name: 'hashtable',
    owner: 'R1',
    implemented: hashtable.IMPLEMENTED,
    instances: () => [new hashtable.OpenAddressingTable<string>()],
    calls: [],
  },
  {
    name: 'ringbuffer',
    owner: 'R5',
    implemented: ringbuffer.IMPLEMENTED,
    instances: () => [
      new ringbuffer.RingBuffer<number>(4),
      new ringbuffer.Float64Ring(4),
      new ringbuffer.ByteRingBuffer(4),
    ],
    calls: [],
  },
  {
    name: 'bloom',
    owner: 'R4',
    implemented: bloom.IMPLEMENTED,
    instances: () => [new bloom.DoubleHashBloom({ nDesign: 1 })],
    calls: [],
  },
  {
    name: 'zorder',
    owner: 'R3',
    implemented: zorder.IMPLEMENTED,
    instances: () => [new zorder.LinkedZOrder()],
    calls: [],
  },
];

/** Assert that `fn` throws the owner's NotImplementedError for `module`. */
function expectTodo(fn: () => unknown, module: string, owner: OwnerRole): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(NotImplementedError);
  const error = thrown as NotImplementedError;
  expect(error).toBeInstanceOf(DsaError);
  expect(error.code).toBe('NOT_IMPLEMENTED');
  expect(error.module).toBe(module);
  expect(error.message).toBe(
    `TODO(${owner}): implement from first principles — see specs/08-dsa/data-structures.md`,
  );
}

/** Every method and getter defined on the instance's class prototype, except the constructor. */
function entryPoints(instance: object): Array<{ key: PropertyKey; call: () => unknown }> {
  const proto = Object.getPrototypeOf(instance) as object;
  return Reflect.ownKeys(proto)
    .filter((key) => key !== 'constructor')
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key) ?? {};
      // Read through Reflect: the getter is invoked on the instance below, never unbound.
      const target: unknown = Reflect.get(descriptor, 'get') ?? Reflect.get(descriptor, 'value');
      if (typeof target !== 'function')
        throw new Error(`${String(key)} is neither a method nor a getter`);
      return { key, call: () => Reflect.apply(target, instance, []) as unknown };
    });
}

describe('dsa scaffold (C16)', () => {
  it('DSA-GEN-08 the package entry point re-exports every structure and its IMPLEMENTED flag', () => {
    expect(dsa.STRUCTURES.map((s) => s.name)).toEqual(ROWS.map((r) => r.name));
    for (const s of dsa.STRUCTURES) {
      const row = ROWS.find((r) => r.name === s.name);
      expect(s.implemented).toBe(row?.implemented);
      expect(s.owner).toBe(row?.owner);
    }
    expect(dsa.BinaryHeap).toBe(heap.BinaryHeap);
    expect(dsa.createTree).toBe(tree.createTree);
    expect(dsa.RadixTrie).toBe(trie.RadixTrie);
  });

  for (const row of ROWS) {
    it.runIf(!row.implemented)(
      `DSA-GEN-08 dsa/${row.name} ships IMPLEMENTED = false and every entry point throws TODO(${row.owner})`,
      () => {
        const module = `dsa/${row.name}`;
        for (const call of row.calls) expectTodo(call, module, row.owner);
        const instances = row.instances();
        for (const instance of instances) {
          const points = entryPoints(instance);
          expect(points.length).toBeGreaterThan(0);
          for (const { call } of points) expectTodo(call, module, row.owner);
        }
        expect(row.calls.length + instances.length).toBeGreaterThan(0);
      },
    );
  }

  it('BOOT-04 CycleError joins the closed cycle path with arrows and UnknownNodeError names both nodes', () => {
    const cycle = new dag.CycleError(['a', 'b', 'a']);
    expect(cycle).toBeInstanceOf(DsaError);
    expect(cycle.code).toBe('CYCLE');
    expect(cycle.name).toBe('CycleError');
    expect(cycle.path).toEqual(['a', 'b', 'a']);
    expect(cycle.message).toBe('a → b → a');
    const unknown = new dag.UnknownNodeError('desktop', 'ghost');
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.name).toBe('UnknownNodeError');
    expect([unknown.node, unknown.missing]).toEqual(['desktop', 'ghost']);
    expect(unknown.message).toBe('desktop requires unknown ghost');
  });
});
