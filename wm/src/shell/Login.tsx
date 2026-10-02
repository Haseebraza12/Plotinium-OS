/**
 * The login and lock screens (boot-and-services.md §3.1 stage 5, BOOT-14; OFF-03): the ui
 * `LoginScreen` driven by `LoginFlow`. Users come from `env.auth.users()` (several users plus the
 * Guest and Demo tiles), a password goes straight to `env.auth.login`, a failure clears and
 * shakes the field, a rate limit counts down, and the unlock transition plays before the desktop
 * is revealed. In lock mode only the signed-in user is offered.
 */
import { createSignal, onCleanup, onMount, untrack, type ComponentProps, type JSX } from 'solid-js';

import type { AuthEnv, BuildIdentity, PowerAction, Session } from './env.ts';
import { LoginFlow, type LoginModel } from './login-flow.ts';
import styles from './Shell.module.css';
import { retag, tagLogin } from './testids.ts';
import type { LoginUser } from './ui.ts';
import { LoginScreen } from './ui.ts';

export interface LoginGateProps {
  auth: AuthEnv;
  identity: BuildIdentity;
  now: () => number;
  /** Lock mode: the signed-in session to unlock. */
  lock?: Session;
  /** Verified: the desktop may mount underneath while the unlock transition plays. */
  onVerified: (s: Session) => void;
  /** The unlock transition finished. */
  onDone: () => void;
  onPower: (action: PowerAction) => void;
  onShown?: () => void;
}

/** The login screen's Accessibility switches (typed from the component; ui.ts is the shell's). */
type LoginA11y = NonNullable<ComponentProps<typeof LoginScreen>['a11y']>;
type LoginA11ySetting = keyof LoginA11y;

function firstSelectable(users: readonly LoginUser[]): string {
  return (
    (users.find((u) => u.disabled !== true && (u.kind ?? 'user') === 'user') ?? users[0])?.id ?? ''
  );
}

export function LoginGate(props: LoginGateProps): JSX.Element {
  let root: HTMLDivElement | undefined;
  // The auth source and the lock target are fixed for the life of this screen.
  const auth = untrack(() => props.auth);
  const lock = untrack(() => props.lock);
  const now = untrack(() => props.now);
  const [users, setUsers] = createSignal<readonly LoginUser[]>(
    lock === undefined ? [] : [{ id: lock.user, name: lock.user, kind: lock.kind, signedIn: true }],
  );
  const [model, setModel] = createSignal<LoginModel>();
  const [clock, setClock] = createSignal(now());
  const flow = new LoginFlow(
    {
      auth,
      now,
      lock: lock !== undefined,
      onChange: (m) => {
        const was = model()?.state;
        setModel(m);
        if (m.state === 'unlocking' && was !== 'unlocking' && m.session !== null)
          props.onVerified(m.session);
      },
      onSignedIn: () => props.onDone(),
    },
    lock?.user ?? '',
  );
  setModel(flow.model);

  onMount(() => {
    const ticker = setInterval(() => {
      setClock(now());
      flow.tick();
    }, 1_000);
    onCleanup(() => clearInterval(ticker));
    const shown = props.onShown;
    if (lock === undefined) {
      void Promise.resolve(auth.users()).then((list) => {
        setUsers(list);
        flow.select(firstSelectable(list));
        shown?.();
      });
    } else shown?.();
    if (root !== undefined) {
      const el = root;
      onCleanup(retag(el, () => tagLogin(el, users(), auth.offline?.() ?? false)));
    }
  });

  const m = (): LoginModel => model() ?? flow.model;
  const retryInS = (): number | undefined => {
    clock();
    return flow.retryInS();
  };

  // The login screen's Accessibility popover (D-17 corner): the switches write the same <html>
  // attributes as the Settings preferences, so they apply before anyone signs in. The signed-in
  // user's own preferences replace them once they load.
  const html = document.documentElement;
  const [a11y, setA11y] = createSignal<LoginA11y>({
    reduceMotion: html.dataset['motion'] === 'reduce',
    reduceTransparency: html.dataset['transparency'] === 'reduce',
  });
  const onA11y = (setting: LoginA11ySetting, on: boolean): void => {
    setA11y((prev) => ({ ...prev, [setting]: on }));
    const key = setting === 'reduceMotion' ? 'motion' : 'transparency';
    if (on) html.dataset[key] = 'reduce';
    else delete html.dataset[key];
  };

  // Plain props only (UI-001): a conditional spread makes Solid merge the props through a
  // function, and every prop read would then subscribe to the 1 s clock behind retryInS().
  return (
    <div ref={(el) => (root = el)} class={styles.lockLayer} data-testid="login-screen">
      <LoginScreen
        users={users()}
        selectedId={m().selectedId}
        onSelectUser={(id) => flow.select(id)}
        now={new Date(clock())}
        onSubmit={(userId, password) => void flow.submit(userId, password)}
        onContinueWithout={(userId) => void flow.continueWithout(userId)}
        state={m().state}
        stage={m().stage}
        errorText={m().errorText}
        errorKey={m().errorKey}
        retryInS={retryInS()}
        offline={auth.offline?.() ?? false}
        sessions={lock === undefined ? undefined : 1}
        sessionsDetail={lock === undefined ? undefined : `${lock.user} — signed in`}
        version={props.identity.version}
        build={props.identity.build}
        onRestart={() => props.onPower('reboot')}
        onShutDown={() => props.onPower('shutdown')}
        a11y={a11y()}
        onA11y={onA11y}
        onUnlocked={() => flow.unlocked()}
      />
    </div>
  );
}
