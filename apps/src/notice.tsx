/**
 * The in-window outcome notice of the system apps (Task Manager, Settings): "Sent SIGTERM to burn
 * (pid 301)", "Could not change the memory budget: … (EINVAL)". A bar along the bottom edge of
 * the window, announced politely (info) or assertively (error), with a dismiss button.
 *
 * It takes its own row under the app (`NOTICE_HOST_STYLE`), so it never covers content or
 * controls (UI-139); popovers and dialogs still open above it.
 *
 * Styles are applied through the CSSOM (hoisted style objects), never as static `style="…"`
 * attributes, which the production CSP refuses (`style-src-attr`, UI-147). Colours and sizes
 * come from ui/src/tokens only (DSN-05; visual-language-macos.md).
 */
import CircleAlert from 'lucide-solid/icons/circle-alert';
import Info from 'lucide-solid/icons/info';
import X from 'lucide-solid/icons/x';
import { Show, type JSX } from 'solid-js';

export interface AppNotice {
  readonly level: 'info' | 'error';
  readonly text: string;
}

export interface NoticeToastProps {
  readonly notice: AppNotice | undefined;
  readonly onDismiss: () => void;
  /**
   * @deprecated The notice is laid out in its own row now (UI-139); kept so older callers still
   * type-check. It has no effect.
   */
  readonly bottom?: string;
}

/**
 * The app root that hosts a notice: the app fills the first row and the notice, when there is
 * one, gets a row of its own below it.
 */
export const NOTICE_HOST_STYLE: JSX.CSSProperties = {
  display: 'grid',
  'grid-template-rows': 'minmax(0, 1fr) auto',
  width: '100%',
  height: '100%',
  'min-height': '0',
};

const BAR_STYLE: JSX.CSSProperties = {
  display: 'flex',
  'align-items': 'center',
  gap: 'var(--pl-space-2)',
  'min-width': '0',
  padding: 'var(--pl-space-1) var(--pl-space-2) var(--pl-space-1) var(--pl-space-4)',
  color: 'var(--pl-text)',
  font: 'var(--pl-type-callout)',
};

const INFO_STYLE: JSX.CSSProperties = {
  ...BAR_STYLE,
  background: 'var(--pl-accent-subtle)',
  'box-shadow': 'inset 0 var(--pl-hairline-width) 0 var(--pl-separator)',
};

const ERROR_STYLE: JSX.CSSProperties = {
  ...BAR_STYLE,
  background: 'var(--pl-danger-subtle)',
  'box-shadow':
    'inset 0 var(--pl-hairline-width) 0 var(--pl-separator), inset 3px 0 0 var(--pl-danger)',
};

const ICON_STYLE: JSX.CSSProperties = { display: 'inline-flex', flex: 'none' };
const INFO_ICON_STYLE: JSX.CSSProperties = { ...ICON_STYLE, color: 'var(--pl-accent-text)' };
const ERROR_ICON_STYLE: JSX.CSSProperties = { ...ICON_STYLE, color: 'var(--pl-danger)' };

const TEXT_STYLE: JSX.CSSProperties = {
  flex: '1 1 auto',
  'min-width': '0',
  'overflow-wrap': 'anywhere',
};

const DISMISS_STYLE: JSX.CSSProperties = {
  display: 'inline-flex',
  'align-items': 'center',
  'justify-content': 'center',
  flex: 'none',
  width: 'var(--pl-target-min)',
  height: 'var(--pl-target-min)',
  border: 'none',
  'border-radius': 'var(--pl-radius-sm)',
  background: 'transparent',
  color: 'var(--pl-text-muted)',
  cursor: 'default',
};

export function NoticeToast(props: NoticeToastProps): JSX.Element {
  return (
    <Show when={props.notice}>
      {(notice) => (
        <div
          class="pl-anim-fade-in"
          role={notice().level === 'error' ? 'alert' : 'status'}
          data-testid="app-notice"
          data-level={notice().level}
          style={notice().level === 'error' ? ERROR_STYLE : INFO_STYLE}
        >
          <span
            aria-hidden="true"
            style={notice().level === 'error' ? ERROR_ICON_STYLE : INFO_ICON_STYLE}
          >
            {notice().level === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}
          </span>
          <span style={TEXT_STYLE}>{notice().text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            class="pl-press"
            onClick={() => {
              props.onDismiss();
            }}
            style={DISMISS_STYLE}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </Show>
  );
}
