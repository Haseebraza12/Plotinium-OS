/**
 * Window-modal sheets of the Files and Editor windows (ui-design-system.md §3.8.11–12): a name
 * prompt (New Folder, New File, Rename, Save As), Change Permissions (octal field plus the 3 × 3
 * matrix and the sticky bit), and a confirmation for destructive actions (DSN-15: Cancel is the
 * safe default and has focus). Built on @plotinium/ui primitives; state stays in the view.
 */
import { Button, Checkbox, Sheet, TextField } from '@plotinium/ui';
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';

import styles from './dialogs.module.css';
import type { PermBit, PermWho } from './lib/model.ts';
import { hasBit, octal, parseMode, withBit } from './lib/model.ts';
import { nameProblem, splitExtension } from './lib/path.ts';

export interface NameSheetProps {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  confirm: string;
  /** Extra validation (for example "must be an absolute path"). */
  validate?: (value: string) => string | undefined;
  /** Select only the stem of `initial` (rename keeps the extension). */
  selectStem?: boolean;
  /** Path fields accept `/`. */
  path?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** One text field and Create / Rename / Save. Enter submits, Escape cancels. */
export function NameSheet(props: NameSheetProps): JSX.Element {
  const [value, setValue] = createSignal('');
  const [touched, setTouched] = createSignal(false);
  let input: HTMLInputElement | undefined;
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setValue(props.initial);
        setTouched(false);
        queueMicrotask(() => {
          if (input === undefined) return;
          input.focus();
          const stem = splitExtension(props.initial).stem.length;
          if (props.selectStem === true) input.setSelectionRange(0, stem);
          else input.select();
        });
      },
    ),
  );
  const problem = (): string | undefined => {
    const v = value();
    if (props.path === true) {
      if (v.trim() === '') return 'Enter a path.';
      const name = v.split('/').pop() ?? '';
      return nameProblem(name) ?? props.validate?.(v);
    }
    return nameProblem(v) ?? props.validate?.(v);
  };
  const submit = (): void => {
    setTouched(true);
    if (problem() === undefined) props.onSubmit(value().trim());
  };
  return (
    <Sheet
      open={props.open}
      title={props.title}
      onClose={() => props.onCancel()}
      actions={
        <div class={styles.actions}>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={touched() && problem() !== undefined}
          >
            {props.confirm}
          </Button>
        </div>
      }
    >
      <TextField
        label={props.label}
        value={value()}
        onInput={(v) => {
          setValue(v);
          setTouched(true);
        }}
        error={touched() ? problem() : undefined}
        mono={props.path === true}
        inputRef={(el) => (input = el)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
    </Sheet>
  );
}

export interface ConfirmSheetProps {
  open: boolean;
  title: string;
  description: string;
  confirm: string;
  /** Third choice, e.g. "Don't Save". */
  alternative?: string;
  /** The confirm button's look: destructive (default, Delete) or primary (Save). */
  confirmVariant?: 'destructive' | 'primary';
  onConfirm: () => void;
  onAlternative?: () => void;
  onCancel: () => void;
}

/** An alert sheet; Cancel has focus (DSN-15), the destructive action is last. */
export function ConfirmSheet(props: ConfirmSheetProps): JSX.Element {
  return (
    <Sheet
      open={props.open}
      role="alertdialog"
      title={props.title}
      description={props.description}
      onClose={() => props.onCancel()}
      actions={
        <div class={styles.actions}>
          <Show when={props.alternative}>
            {(label) => (
              <Button variant="danger" onClick={() => props.onAlternative?.()}>
                {label()}
              </Button>
            )}
          </Show>
          <Button data-autofocus onClick={() => props.onCancel()}>
            Cancel
          </Button>
          <Button variant={props.confirmVariant ?? 'destructive'} onClick={() => props.onConfirm()}>
            {props.confirm}
          </Button>
        </div>
      }
    />
  );
}

const WHO: readonly { id: PermWho; label: string }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'group', label: 'Group' },
  { id: 'others', label: 'Others' },
];
const BITS: readonly { id: PermBit; label: string }[] = [
  { id: 'r', label: 'Read' },
  { id: 'w', label: 'Write' },
  { id: 'x', label: 'Execute' },
];

export interface ChmodSheetProps {
  open: boolean;
  /** "report.md" or "3 items". */
  subject: string;
  mode: number;
  /** Folders show the sticky bit. */
  folder: boolean;
  onApply: (mode: number) => void;
  onCancel: () => void;
}

/** Change Permissions: an octal field and a labelled 3 × 3 checkbox grid kept in step. */
export function ChmodSheet(props: ChmodSheetProps): JSX.Element {
  const [mode, setMode] = createSignal(0);
  const [text, setText] = createSignal('');
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setMode(props.mode & 0o1777);
        setText(octal(props.mode & 0o1777));
      },
    ),
  );
  const setBits = (next: number): void => {
    setMode(next);
    setText(octal(next));
  };
  const textProblem = (): string | undefined =>
    parseMode(text()) === undefined
      ? 'Use an octal mode such as 644, or rwxr-xr-x (no setuid or setgid).'
      : undefined;
  return (
    <Sheet
      open={props.open}
      title="Change Permissions"
      description={`Who may read, write and run ${props.subject}.`}
      onClose={() => props.onCancel()}
      actions={
        <div class={styles.actions}>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={textProblem() !== undefined}
            onClick={() => props.onApply(mode())}
          >
            Apply
          </Button>
        </div>
      }
    >
      <div class={styles.stack}>
        <TextField
          label="Mode"
          mono
          value={text()}
          hint="Octal (for example 0644) or symbolic (rw-r--r--)."
          error={textProblem()}
          onInput={(v) => {
            setText(v);
            const parsed = parseMode(v);
            if (parsed !== undefined) setMode(parsed);
          }}
        />
        <div role="group" aria-label="Permission bits" class={styles.matrix}>
          <span />
          <For each={BITS}>{(b) => <span class={styles.matrixHead}>{b.label}</span>}</For>
          <For each={WHO}>
            {(w) => (
              <>
                <span class={styles.cell}>{w.label}</span>
                <For each={BITS}>
                  {(b) => (
                    <span class={styles.cell}>
                      <input
                        type="checkbox"
                        class={styles.check}
                        aria-label={`${w.label} ${b.label.toLowerCase()}`}
                        checked={hasBit(mode(), w.id, b.id)}
                        onChange={(event) =>
                          setBits(withBit(mode(), w.id, b.id, event.currentTarget.checked))
                        }
                      />
                    </span>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
        <Show when={props.folder}>
          <Checkbox
            label="Sticky: only owners may delete or rename entries"
            checked={(mode() & 0o1000) !== 0}
            onChange={(on) => setBits(on ? mode() | 0o1000 : mode() & ~0o1000)}
          />
        </Show>
      </div>
    </Sheet>
  );
}
