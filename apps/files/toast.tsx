/**
 * The in-window toast of the Files and Editor windows: a short HUD pill at the bottom centre for
 * progress, success and failures (with the errno beside the sentence, DSN-08: the tone is named
 * by the words as well as the colour). Errors are `role="alert"`, the rest `role="status"`.
 * The view dismisses it after a few seconds; a click dismisses it at once. A toast may carry one
 * action button (Undo after Move to Trash).
 */
import { Show, type JSX } from 'solid-js';

import styles from './toast.module.css';

export interface ToastData {
  readonly id: number;
  readonly tone: 'info' | 'success' | 'error';
  readonly text: string;
  readonly errno?: string;
  readonly action?: { readonly id: string; readonly label: string };
}

/** How long a toast stays: errors and toasts with an action longer (an Undo needs time). */
export function toastLifetimeMs(toast: Pick<ToastData, 'tone' | 'action'>): number {
  if (toast.action !== undefined) return 10_000;
  return toast.tone === 'error' ? 7_000 : 3_500;
}

export function ToastView(props: {
  toast: ToastData | undefined;
  onDismiss: (id: number) => void;
  onAction?: (actionId: string, toastId: number) => void;
}): JSX.Element {
  return (
    <Show when={props.toast}>
      {(toast) => (
        <div
          role={toast().tone === 'error' ? 'alert' : 'status'}
          data-testid="app-toast"
          data-tone={toast().tone}
          class={`${styles.toast} pl-anim-pop-in`}
          onClick={() => props.onDismiss(toast().id)}
        >
          <span class={styles.text}>
            {toast().text}
            <Show when={toast().errno}>
              {(errno) => <span class={styles.errno}> ({errno()})</span>}
            </Show>
          </span>
          <Show when={props.onAction === undefined ? undefined : toast().action}>
            {(action) => (
              <button
                type="button"
                class={styles.action}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onAction?.(action().id, toast().id);
                }}
              >
                {action().label}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
