import { splitProps, type JSX } from 'solid-js';

import {
  editorIcon,
  filesIcon,
  searchIcon,
  settingsIcon,
  taskManagerIcon,
  terminalIcon,
  trashFullIcon,
  trashIcon,
} from './app-icons.ts';
import { atomLogo, atomLogoFor } from './atom-logo.ts';
import { SvgIcon, type SvgIconProps } from './SvgIcon.tsx';
import { toSvgString, type SvgIconDef } from './svg-tree.ts';

export { atomLogoFor } from './atom-logo.ts';
export { SvgIcon, type SvgIconProps } from './SvgIcon.tsx';
export { toSvgString, type SvgIconDef, type SvgNode } from './svg-tree.ts';

/** Every stored icon, by app id. */
export const ICON_DEFS = {
  atom: atomLogo,
  files: filesIcon,
  terminal: terminalIcon,
  editor: editorIcon,
  'task-manager': taskManagerIcon,
  settings: settingsIcon,
  search: searchIcon,
  trash: trashIcon,
  'trash-full': trashFullIcon,
} as const satisfies Record<string, SvgIconDef>;

export type IconId = keyof typeof ICON_DEFS;

/** The stored drawing for an id at a pixel size (the mark has hinted drawings for 20 and 24 px). */
function defFor(id: IconId, size: number): SvgIconDef {
  return id === 'atom' ? atomLogoFor(size) : ICON_DEFS[id];
}

/** Raw SVG document for favicons, the manifest and the inlined boot-ui. */
export function rawIcon(id: IconId, size = 256): string {
  return toSvgString(defFor(id, size), size);
}

/** The Plotinium mark, drawn with the hinting for its size (atomLogoFor). */
export const AtomLogo = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={atomLogoFor(props.size ?? 24)} {...props} />
);
export const FilesAppIcon = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={filesIcon} {...props} />
);
export const TerminalAppIcon = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={terminalIcon} {...props} />
);
export const EditorAppIcon = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={editorIcon} {...props} />
);
export const TaskManagerAppIcon = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={taskManagerIcon} {...props} />
);
export const SettingsAppIcon = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={settingsIcon} {...props} />
);
export const SearchAppIcon = (props: SvgIconProps): JSX.Element => (
  <SvgIcon def={searchIcon} {...props} />
);
export function TrashAppIcon(props: SvgIconProps & { full?: boolean }): JSX.Element {
  const [local, rest] = splitProps(props, ['full']);
  return <SvgIcon def={local.full === true ? trashFullIcon : trashIcon} {...rest} />;
}

/** Renders the stored icon for an id. */
export function AppIcon(props: SvgIconProps & { app: IconId }): JSX.Element {
  const [local, rest] = splitProps(props, ['app']);
  return <SvgIcon def={defFor(local.app, rest.size ?? 24)} {...rest} />;
}
