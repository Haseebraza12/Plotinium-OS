/**
 * A placeholder desktop, mounted when the `desktop` service starts, so the boot reaches a real
 * `desktop-interactive` mark. The UI workflow's shell (ui/ components driven by wm/shell and the
 * compositor) replaces it in the integration step. It shows the truth: every service and its state.
 */
import type { Accessor } from 'solid-js';
import { createSignal, For, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';

export interface ServiceRow {
  readonly name: string;
  readonly state: string;
  readonly reason?: string;
}

/** The boot driver's service list: plain data plus change notifications. */
export interface ServiceFeed {
  current(): readonly ServiceRow[];
  subscribe(fn: (rows: readonly ServiceRow[]) => void): () => void;
}

export interface PlaceholderProps {
  readonly version: string;
  readonly build: string;
  readonly services: ServiceFeed;
}

interface ViewProps {
  readonly version: string;
  readonly build: string;
  readonly services: Accessor<readonly ServiceRow[]>;
}

function Placeholder(props: ViewProps) {
  return (
    <main data-testid="desktop" class="plt-placeholder-desktop" aria-label="Plotinium desktop">
      <header data-testid="menubar">
        <strong>Plotinium</strong> {props.version} · build {props.build}
      </header>
      <p>The kernel is up. The desktop shell mounts here in the integration step.</p>
      <table aria-label="Services">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.services()}>
            {(s) => (
              <tr>
                <td>{s.name}</td>
                <td>
                  {s.state}
                  <Show when={s.reason}>{(r) => <span> · {r()}</span>}</Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </main>
  );
}

/** Mount into `root`; returns the dispose function. */
export function mountPlaceholderDesktop(root: HTMLElement, props: PlaceholderProps): () => void {
  return render(() => {
    const [rows, setRows] = createSignal(props.services.current());
    onCleanup(props.services.subscribe(setRows));
    return <Placeholder version={props.version} build={props.build} services={rows} />;
  }, root);
}
