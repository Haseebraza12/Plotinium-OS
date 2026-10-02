import { EVENT_PAYLOADS, INO } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { EventStamper, capItems, filterEvent, toBusEvents } from '../src/events.ts';
import type { VfsEvent, VfsEventDraft } from '../src/events.ts';
import { EVENT_ITEMS_MAX } from '../src/limits.ts';
import { planChmod, planChown, planUtimes } from '../src/ops/attr.ts';
import { forRemove } from '../src/ops/common.ts';
import { planMkdir, planSymlink } from '../src/ops/create.ts';
import { planLink } from '../src/ops/link.ts';
import { planRename } from '../src/ops/rename.ts';
import { planRemoveTree } from '../src/ops/unlink.ts';
import { planContentWrite, planWriteFile } from '../src/ops/write.ts';
import type { PlanBuilder } from '../src/ops/plan.ts';
import type { OpKind } from '../src/store/records.ts';
import { ALICE, ROOT, World, ok, testIno } from './doubles/world.ts';

function drafts(): VfsEventDraft[] {
  const w = new World();
  const out: VfsEventDraft[] = [];
  const grab = (cred: typeof ROOT, call: OpKind, fn: (b: PlanBuilder) => unknown): void => {
    const r = w.plan(cred, call, fn);
    out.push(...r.plan.events);
    w.commit(r.plan, testIno(0xe0 + out.length), cred.uid);
  };
  grab(ALICE, 'create', (b) => planMkdir(b, '/home/alice/d'));
  grab(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/d/f', contentOfText('1', 0)));
  grab(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/d/f', contentOfText('22', 0)));
  grab(ALICE, 'link', (b) => planLink(b, '/home/alice/d/f', '/home/alice/d/g'));
  grab(ALICE, 'rename', (b) => planRename(b, '/home/alice/d/g', '/home/alice/g'));
  grab(ALICE, 'chmod', (b) => planChmod(b, '/home/alice/d', { kind: 'octal', bits: 0o700 }, true));
  grab(ROOT, 'chown', (b) => planChown(b, '/home/alice/d', { uid: 1001, recursive: true }));
  grab(ROOT, 'utimes', (b) => planUtimes(b, '/home/alice/g', { mtime: 'now' }));
  grab(ALICE, 'create', (b) => planSymlink(b, 'g', '/home/alice/s'));
  grab(ALICE, 'rename', (b) => planRename(b, '/home/alice/s', '/home/alice/g'));
  grab(ROOT, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/alice/d')));
  const f = ok(
    w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/c.txt', contentOfText('x', 0))),
  );
  ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/c.txt', contentOfText('y', 0))));
  grab(ALICE, 'write', (b) => planContentWrite(b, f.ino, contentOfText('late', 0), 1, null));
  return out;
}

describe('vfs events (RAG-02, RAG-03, SYS-03)', () => {
  it('RAG-02 vfs.write, vfs.rename and vfs.unlink carry inode ids and project to the ABI payloads', () => {
    const d = drafts();
    expect(d.map((e) => e.topic)).toEqual([
      'vfs.create',
      'vfs.create',
      'vfs.write',
      'vfs.link',
      'vfs.rename',
      'vfs.chmod',
      'vfs.chown',
      'vfs.utimes',
      'vfs.create',
      'vfs.rename',
      'vfs.unlink',
      'vfs.unlink',
      'vfs.create',
      'vfs.conflict',
    ]);
    const stamped = new EventStamper().stamp(d, {
      t: 1,
      origin: 'local',
      actorUid: 1000,
      opId: testIno(1),
    });
    expect(stamped.map((e) => e.vseq)).toEqual(d.map((_, i) => i + 1));
    for (const e of stamped) {
      for (const bus of toBusEvents(e)) {
        // Valibot schemas implement Standard Schema: validate without importing valibot here.
        const result = EVENT_PAYLOADS[bus.topic]['~standard'].validate(bus.data);
        expect(
          'issues' in result && result.issues !== undefined,
          `${bus.topic} ${JSON.stringify(bus.data)}`,
        ).toBe(false);
      }
    }
    const unlink = stamped.find((e) => e.topic === 'vfs.unlink' && e.data.items[0]?.count === 2);
    expect(unlink?.topic === 'vfs.unlink' && unlink.data.items[0]?.inos.length).toBe(2);
    expect(toBusEvents({ ...stamped[0], origin: 'remote' } as VfsEvent)[0]?.data).toMatchObject({
      origin: 'remote',
    });
  });

  it('RAG-03 vfs events are filtered by r on the parent and x on every ancestor', () => {
    const stamped = new EventStamper().stamp(drafts(), { t: 1, origin: 'local', actorUid: 1000 });
    const none = stamped.map((e) => filterEvent(e, () => false)).filter((e) => e !== null);
    expect(none.map((e) => e.topic)).toEqual(['vfs.utimes']);
    const all = stamped.map((e) => filterEvent(e, () => true, true)).filter((e) => e !== null);
    expect(all).toHaveLength(stamped.length);
    const rename = stamped.find((e) => e.topic === 'vfs.rename');
    if (rename?.topic !== 'vfs.rename') throw new Error('no rename');
    const from = rename.data.items[0]?.from?.parent;
    const half = filterEvent(rename, (dir) => dir === from);
    expect(half?.topic === 'vfs.rename' && half.data.items[0]?.to).toBeNull();
    expect(toBusEvents(half as VfsEvent)).toEqual([]);
    const conflict = stamped.find((e) => e.topic === 'vfs.conflict');
    expect(conflict && filterEvent(conflict, () => false, true)).toBe(conflict);
    const load: VfsEvent = {
      topic: 'vfs.load',
      data: { dir: INO.ROOT, entries: [] },
      vseq: 1,
      t: 1,
      origin: 'local',
      actorUid: 0,
    };
    expect(filterEvent(load, () => false)).toBeNull();
    const revert: VfsEvent = {
      topic: 'vfs.revert',
      data: { opId: testIno(1), errno: 'EIO' },
      vseq: 2,
      t: 1,
      origin: 'revert',
      actorUid: 0,
    };
    expect(filterEvent(revert, () => true)).toBeNull();
    expect(filterEvent(revert, () => true, true)).toBe(revert);
    expect(toBusEvents(revert)).toEqual([]);
  });

  it('SYS-03 item arrays beyond 10,000 are cut and marked truncated', () => {
    const items = Array.from({ length: EVENT_ITEMS_MAX + 5 }, (_, i) => ({
      ino: testIno(i),
      mtime: i,
    }));
    const cut = capItems({ topic: 'vfs.utimes', data: { items } });
    expect(cut.topic === 'vfs.utimes' && cut.data.items.length).toBe(EVENT_ITEMS_MAX);
    expect('truncated' in cut.data && cut.data.truncated).toBe(true);
    const small = { topic: 'vfs.utimes' as const, data: { items: items.slice(0, 2) } };
    expect(capItems(small)).toBe(small);
    const big = {
      topic: 'vfs.unlink' as const,
      data: {
        items: [
          {
            parent: INO.ROOT,
            name: 'x',
            ino: testIno(1),
            type: 'd' as const,
            inos: items.map((i) => i.ino),
            count: items.length,
          },
        ],
      },
    };
    const ev = new EventStamper().stamp([big], { t: 1, origin: 'local', actorUid: 0 })[0];
    const bus = ev === undefined ? [] : toBusEvents(ev);
    expect(bus[0]?.topic === 'vfs.unlink' && bus[0].data.inos.length).toBe(1000);
    expect(bus[0]?.topic === 'vfs.unlink' && bus[0].data.truncated).toBe(true);
  });
});
