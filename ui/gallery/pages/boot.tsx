/**
 * Boot screens: the framework-free splash, boot menu, verbose log, kernel panic, recovery
 * console and unsupported-browser card (ui/src/boot), each at 1280 × 800 in both themes.
 * The live splash is driven by a recorded boot, one event per step, exactly as wm/boot-ui
 * drives it; the gallery's own toggles set the theme and reduced motion.
 */
import '../../src/boot/boot.css';

import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';

import {
  createBootMenu,
  createBootSplash,
  createPanicScreen,
  createRecoveryConsole,
  createUnsupportedScreen,
  parseBootLine,
  Say,
  type BootLogLine,
  type BootMenu,
  type BootSplash,
  type CapabilityRow,
  type CheckItem,
} from '../../src/boot/index.ts';
import { Button } from '../../src/primitives/button/Button.tsx';
import { Page, Section } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './boot.module.css';

export const meta: GalleryPageMeta = {
  id: 'boot',
  title: 'Boot screens',
  group: 'Boot',
  order: 1,
  description:
    'Splash, boot menu, verbose log, kernel panic, recovery console and unsupported browser.',
};

const ID = { version: '0.3.0', build: 'a1f93c2' } as const;
const W = 1280;
const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

interface Mountable {
  readonly el: HTMLElement;
  destroy(): void;
}

/** Hosts one framework-free screen at 1280 × 800, scaled to the card width. */
function Frame(props: { theme: Theme; label: string; make: () => Mountable }): JSX.Element {
  let outer: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;
  onMount(() => {
    const box = outer;
    const stage = inner;
    if (box === undefined || stage === undefined) return;
    const screen = props.make();
    stage.append(screen.el);
    const fit = (): void => stage.style.setProperty('--frame-scale', String(box.clientWidth / W));
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    fit();
    onCleanup(() => {
      observer.disconnect();
      screen.destroy();
    });
  });
  return (
    <div
      ref={(el) => (outer = el)}
      class={styles.frame}
      data-theme={props.theme}
      role="group"
      aria-label={props.label}
    >
      <div ref={(el) => (inner = el)} class={styles.inner} />
    </div>
  );
}

function Pair(props: { label: string; make: (theme: Theme) => Mountable }): JSX.Element {
  return (
    <div class={styles.frames}>
      <For each={THEMES}>
        {(theme) => (
          <Frame theme={theme} label={`${props.label}, ${theme}`} make={() => props.make(theme)} />
        )}
      </For>
    </div>
  );
}

/** One recorded boot event, as the kernel and the asset loader report it. */
interface BootEvent {
  readonly p: number;
  readonly stage: number;
  readonly step: string;
  readonly line: string;
  readonly done?: number;
  readonly say?: string;
  readonly ok?: boolean;
}

/** Mirrors the illustrative boot of boot-and-services.md §3.7 (values are samples). */
const EVENTS: readonly BootEvent[] = [
  {
    p: 0.02,
    stage: 1,
    step: 'checking system',
    say: 'Checking system',
    line: '[    0.000] firmware: Plotinium 0.3.0 · POST ok (workers, indexeddb, opfs, crypto, isolated) · quota 2.1 GB, persisted',
  },
  {
    p: 0.1,
    stage: 2,
    step: 'Loading kernel · 38 of 104 KB',
    line: '[    0.004] loader: profile=normal · service worker active (offline-capable) · kernel image 104 KB (cache)',
  },
  {
    p: 0.26,
    stage: 3,
    step: 'kernel: process table ready · pid 1 = init',
    done: 1,
    say: 'Kernel ready',
    line: '[    0.058] kernel: process table ready (hash table, cap 64) · pid 1 = init · klog 8192',
  },
  {
    p: 0.29,
    stage: 4,
    step: 'svc: 18 manifests · 30 edges · acyclic · 7 levels',
    say: 'Starting services',
    line: '[    0.060] svc: 18 manifests (volume) · 30 edges · acyclic · 7 levels',
  },
  {
    p: 0.34,
    stage: 4,
    step: 'sched: priority heap + RR · quanta 5/10/20 ms',
    done: 2,
    line: '[    0.061] sched: priority heap + RR · quanta 5/10/20 ms · aging 250 ms · executors 1/4 · run tokens 2',
  },
  {
    p: 0.45,
    stage: 4,
    step: 'storage: opened plotinium v7 (IndexedDB) · epoch 38',
    done: 4,
    line: '[    0.122] storage: opened plotinium v7 (IndexedDB) in 61 ms · epoch 38',
  },
  {
    p: 0.51,
    stage: 4,
    step: 'mm: budget 256 MB · swap tiers: opfs, server',
    done: 5,
    line: '[    0.130] mm: budget 256 MB · swap tiers: opfs, server (write-behind)',
  },
  {
    p: 0.62,
    stage: 4,
    step: 'vfs: mounting / (12,408 inodes)',
    done: 6,
    say: 'Starting vfs, 6 of 9',
    line: '[    0.212] vfs: mounted / · 12,408 inodes · 3 users · quotas enforced · quick check clean',
  },
  {
    p: 0.71,
    stage: 5,
    step: 'login: session restored for uid 1001 (alice)',
    done: 7,
    say: 'Signing in',
    line: '[    0.341] login: session restored for uid=1001 (alice) · user wait 0.000 s',
  },
  {
    p: 0.71,
    stage: 5,
    step: 'sync: offline · outbox holds 3 ops',
    say: 'sync is degraded: offline',
    line: '[    0.402] sync: WARN backend unreachable · offline mode · outbox holds 3 ops · retry in 2 s',
  },
  {
    p: 0.71,
    stage: 5,
    step: 'lockd: local advisory locks only',
    line: '[    0.405] lockd: DEGRADED (requires sync) · local advisory locks only',
  },
  {
    p: 0.83,
    stage: 6,
    step: 'session: restoring 4 windows',
    done: 8,
    say: 'Restoring session',
    line: '[    0.590] session: layout restored · 4 windows · frames painted',
  },
  {
    p: 1,
    stage: 6,
    step: 'desktop: interactive · boot 0.73 s',
    done: 9,
    say: 'Desktop ready',
    ok: true,
    line: '[    0.731] desktop: interactive · 4 windows restored · boot 0.73 s · 2 services degraded',
  },
];

function logLine(event: BootEvent): BootLogLine[] {
  const line = parseBootLine(event.line);
  if (line === null) return [];
  return [event.ok === true ? { ...line, level: 'ok' } : line];
}

/** Applies one recorded event the way wm/boot-ui does: every change comes from an event. */
function apply(splash: BootSplash, event: BootEvent): void {
  splash.setStage(event.stage);
  splash.setProgress(event.p, event.say ?? event.step);
  splash.setStep(event.step);
  splash.pulse();
  splash.log.append(...logLine(event));
  if (event.done !== undefined) {
    splash.setCount(event.done, 9);
    splash.serviceDone();
  }
  if (event.stage >= 2) splash.setMenuAvailable(false);
  if (event.say !== undefined) splash.announcer.say(event.say, Say.Stage);
}

function splashAt(count: number, verbose: boolean): BootSplash {
  const splash = createBootSplash(ID);
  EVENTS.slice(0, count).forEach((e) => apply(splash, e));
  splash.setVerbose(verbose);
  return splash;
}

function LiveSplash(props: { onIntent: (text: string) => void }): JSX.Element {
  const [generation, setGeneration] = createSignal(1);
  const [next, setNext] = createSignal(0);
  const [verbose, setVerbose] = createSignal(false);
  let splash: BootSplash | undefined;
  let frame = 0;

  const step = (): void => {
    const event = EVENTS[next()];
    if (splash === undefined || event === undefined) return;
    apply(splash, event);
    setNext(next() + 1);
  };
  const stop = (): void => cancelAnimationFrame(frame);
  /** Replays the recorded boot, one event every ~260 ms of animation frames (gallery only). */
  const play = (): void => {
    reset();
    let last = 0;
    const tick = (t: number): void => {
      if (t - last >= 260) {
        last = t;
        step();
      }
      if (next() < EVENTS.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };
  const reset = (): void => {
    stop();
    setNext(0);
    setVerbose(false);
    setGeneration(generation() + 1);
  };
  onCleanup(stop);

  return (
    <Section
      title="Splash (live)"
      lead="Every change is a real boot event: bytes received, a klog line, a service reaching done. Between events the screen is still, so a stalled boot looks stalled."
    >
      <div class={styles.controls}>
        <Button size="sm" variant="primary" onClick={play}>
          Play boot
        </Button>
        <Button size="sm" onClick={step} disabled={next() >= EVENTS.length}>
          Next event ({next()} of {EVENTS.length})
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setVerbose(!verbose());
            splash?.setVerbose(verbose());
          }}
        >
          {verbose() ? 'Hide log (V)' : 'Verbose log (V)'}
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Reset
        </Button>
      </div>
      <Show keyed when={generation()}>
        {(run) => (
          <div class={styles.frames} data-run={run}>
            <Frame
              theme="dark"
              label="Live boot splash"
              make={() => {
                const created = createBootSplash({
                  ...ID,
                  onBootMenu: () => props.onIntent('splash: onBootMenu()'),
                  onToggleVerbose: () => {
                    setVerbose(!verbose());
                    created.setVerbose(verbose());
                  },
                });
                splash = created;
                return created;
              }}
            />
          </div>
        )}
      </Show>
    </Section>
  );
}

const CHECKS: readonly CheckItem[] = [
  { label: 'Every inode reachable from /', state: 'passed', detail: '12,408 / 12,408' },
  { label: 'Link counts correct', state: 'passed', detail: '0 mismatches' },
  { label: 'No directory cycles', state: 'passed', detail: 'tree verified · depth 9' },
  { label: 'Quota totals consistent', state: 'running', detail: 'student ✓ alice ✓ bob' },
  { label: 'Blob refcounts & structure', state: 'pending' },
];

const FSCK_LOG = [
  '[    0.004] fsck: mode check · target / · store plotinium v7 · read-only',
  '[    0.012] fsck: pass 1 inodes · 12408 inodes · 3 uids · ok',
  '[    0.027] fsck: pass 2 dentries · 12407 entries · names valid · ok',
  '[    0.041] fsck: pass 3 reachability · BFS from / · 0 orphans · 0 cycles · ok',
  '[    0.066] fsck: pass 4 counts · nlink ok · 0 dangling links',
  '[    0.090] fsck: pass 4 quota · /home/student 212 MB · /home/alice 96 MB · /home/bob …',
];

const CAPS: readonly CapabilityRow[] = [
  { name: 'Secure context', probe: 'localhost:4717', status: 'pass', required: true },
  { name: 'Module workers', status: 'pass', required: true },
  { name: 'IndexedDB', status: 'pass', required: true },
  { name: 'Web Locks', status: 'pass', required: true },
  { name: 'WebCrypto', probe: 'crypto.subtle', status: 'pass', required: true },
  {
    name: 'Origin Private File System',
    status: 'missing',
    fix: 'Swap falls back to IndexedDB (plotinium-swap) · slower paging',
  },
  {
    name: 'Cross-origin isolation',
    status: 'degraded',
    fix: 'Pre-emption falls back to messages · AI search runs single-threaded',
  },
];

export default function BootPage(): JSX.Element {
  const [intent, setIntent] = createSignal('none yet');
  const [remaining, setRemaining] = createSignal(5);
  const menus: BootMenu[] = [];
  const say = (text: string): void => {
    setIntent(text);
  };

  return (
    <Page
      title="Boot screens"
      lead="Framework-free (plain TypeScript and boot.css), inlined into index.html before any framework loads. They hold no timers: wm/boot-ui drives them from real boot events, and they report the user's choices through callbacks."
    >
      <p class={styles.intent} aria-live="polite">
        Last intent: {intent()}
      </p>

      <LiveSplash onIntent={say} />

      <Section
        title="Splash"
        lead="Stage 4 at P = 0.62: vfs mounting, 6 of 9 services done. The orbits advance one tick per event and the sheen sweeps once per progress update."
      >
        <Pair label="Boot splash" make={() => splashAt(8, false)} />
      </Section>

      <Section
        title="Verbose log"
        lead="V toggles it at any time. The column becomes a compact header and the virtualised, append-only log rises beneath it; WARN and DEGRADED are text, not colour alone."
      >
        <Pair label="Verbose boot log" make={() => splashAt(EVENTS.length, true)} />
      </Section>

      <Section
        title="Boot menu"
        lead="↑/↓, Home/End, 1–4, Enter and Esc. The countdown ring is drawn only while the menu is open; wm/boot-ui owns its timer and ticks it here. Any key stops it."
      >
        <div class={styles.controls}>
          <Button
            size="sm"
            onClick={() => {
              const left = Math.max(0, remaining() - 1);
              setRemaining(left);
              menus.forEach((m) => m.setCountdown(left, 5));
            }}
          >
            Countdown tick ({remaining()} s)
          </Button>
        </div>
        <Pair
          label="Boot menu"
          make={(theme) => {
            const menu = createBootMenu({
              ...ID,
              failedBoots: theme === 'light' ? 2 : 0,
              onChoose: (mode) => say(`menu: onChoose('${mode}')`),
              onClose: () => say('menu: onClose()'),
              onInteract: () => say('menu: onInteract() (countdown stopped)'),
            });
            menu.setCountdown(remaining(), 5);
            menus.push(menu);
            return menu;
          }}
        />
      </Section>

      <Section
        title="Kernel panic"
        lead="A dependency cycle halts the boot (BOOT-04). R, S and D work wherever focus is; focus starts on Recovery console."
      >
        <Pair
          label="Kernel panic"
          make={() =>
            createPanicScreen({
              ...ID,
              bootId: '7f3e·b12c',
              time: '2026-09-24 09:41:07 PKT · uptime 0.060 s',
              cycle: ['auth', 'sync', 'lockd', 'auth'],
              lines: [
                { t: 0.06, sub: 'svc', msg: '18 manifests (volume) · 31 edges' },
                {
                  t: 0.06,
                  sub: 'svc',
                  msg: 'KERNEL PANIC: dependency cycle detected: auth → sync → lockd → auth',
                },
                { t: 0.06, sub: 'kernel', msg: 'boot halted before storage mount · pid 1 = init' },
              ],
              onAction: (a) => say(`panic: onAction('${a}')`),
            })
          }
        />
      </Section>

      <Section
        title="Recovery console"
        lead="Single-user, read-only file system. Letter keys run actions; destructive ones ask again with Cancel as the default."
      >
        <Pair
          label="Recovery console"
          make={() => {
            const rc = createRecoveryConsole({
              ...ID,
              bootId: '0x7c2e',
              status: 'Offline · storage 412 MB used',
              onAction: (a) => say(`recovery: onAction('${a}')`),
            });
            rc.setChecklist(CHECKS);
            rc.setProgress(0.78, 'Stage 4 of 5 · quota totals · 78%');
            rc.output.append(
              ...FSCK_LOG.flatMap((text) => {
                const line = parseBootLine(text);
                return line === null ? [] : [line];
              }),
            );
            rc.setBusy('fsck');
            return rc;
          }}
        />
      </Section>

      <Section
        title="Unsupported browser"
        lead="Dark: only degradable capabilities are missing, so Continue is offered. Light: a required capability is missing; the title is the identity string and there is no Continue."
      >
        <Pair
          label="Unsupported browser"
          make={(theme) =>
            createUnsupportedScreen({
              ...ID,
              platform: 'Chrome 128 on Linux',
              capabilities:
                theme === 'dark'
                  ? CAPS
                  : CAPS.map((c) =>
                      c.name === 'Web Locks'
                        ? {
                            ...c,
                            status: 'missing',
                            fix: 'Open http://localhost:4717, not a LAN IP',
                          }
                        : c,
                    ),
              requirementsHref: 'https://localhost:4717/docs/requirements',
              onContinue: () => say('unsupported: onContinue()'),
              onCopyDiagnostics: () => say('unsupported: onCopyDiagnostics()'),
            })
          }
        />
      </Section>
    </Page>
  );
}
