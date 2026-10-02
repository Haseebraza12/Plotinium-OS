/**
 * The About Plotinium window (identity-and-branding.md §3.10 row 9; DSN-18): `AboutPane` from
 * @plotinium/ui fed by `loadAbout` (uname, credentials, budget, storage) and identity.json.
 */
import { ErrorBoundary, createResource, createSignal, onMount, Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';

import type { SettingsAction } from '@plotinium/ui/apps/settings';
import { AboutPane } from '@plotinium/ui/apps/settings';

import type { AppViewContext } from '../src/descriptor.ts';
import { loadAbout } from './controller.ts';
import { systemReport, toAboutModel, unameLine } from './model.ts';

/*
 * Styles go through the CSSOM (hoisted objects): static `style="…"` attributes in Solid's
 * templates are refused by the production CSP (`style-src-attr`, UI-147).
 */
const ROOT_STYLE: JSX.CSSProperties = {
  width: '100%',
  height: '100%',
  overflow: 'auto',
  padding: 'var(--pl-space-2) var(--pl-space-6) var(--pl-space-4)',
  'box-sizing': 'border-box',
};

const STATUS_STYLE: JSX.CSSProperties = {
  margin: 'var(--pl-space-3) 0 0',
  'text-align': 'center',
  color: 'var(--pl-text-muted)',
  font: 'var(--pl-type-caption)',
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The window's root component, closed over its (non-reactive) view context. */
function aboutApp(ctx: AppViewContext): () => JSX.Element {
  return function AboutApp(): JSX.Element {
    const [status, setStatus] = createSignal('');
    const [state] = createResource(() => loadAbout(ctx.sys, ctx.env));
    // Until the first answer, show the build identity (never a blank window).
    const fallback = toAboutModel({
      identity: ctx.env.identity,
      ...(ctx.env.team === undefined ? {} : { team: ctx.env.team }),
      uname: null,
      budgetBytes: null,
      storage: null,
      user: ctx.env.user ?? null,
      updateAvailable: null,
    });
    const model = () => state()?.model ?? fallback;

    // The About pane raises only the three about.* actions; the rest belong to Settings panes.
    const onAction = (action: SettingsAction): void => {
      if (action === 'about.systemReport') {
        void copyText(systemReport(model(), state()?.uname ?? null)).then((ok) =>
          setStatus(
            ok ? 'System report copied to the clipboard.' : 'Could not copy the system report.',
          ),
        );
      } else if (action === 'about.copyUname') {
        const u = state()?.uname;
        if (u === null || u === undefined) {
          setStatus(
            `uname is unavailable: ${state()?.unameError ?? 'the kernel has not answered yet'}`,
          );
          return;
        }
        void copyText(unameLine(u)).then((ok) =>
          setStatus(ok ? 'uname -a copied.' : 'Could not copy.'),
        );
      } else if (action === 'about.licences') {
        setStatus(
          'Third-party licences are listed in THIRD_PARTY.md at the root of the repository.',
        );
      }
    };

    onMount(() => {
      ctx.window.setTitle('About Plotinium');
    });

    return (
      <div style={ROOT_STYLE}>
        <AboutPane
          about={model()}
          onCopy={(_label, value) => void copyText(value)}
          onAction={onAction}
        />
        <Show when={status() !== ''}>
          <p role="status" style={STATUS_STYLE}>
            {status()}
          </p>
        </Show>
      </div>
    );
  };
}

/** The view module's entry (apps/src/descriptor.ts `AppMount`). */
export function mount(ctx: AppViewContext): () => void {
  const AboutApp = aboutApp(ctx);
  return render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          ctx.reportCrash(err);
          return null;
        }}
      >
        <AboutApp />
      </ErrorBoundary>
    ),
    ctx.container,
  );
}

export default mount;
