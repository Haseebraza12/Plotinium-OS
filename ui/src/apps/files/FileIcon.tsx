import File from 'lucide-solid/icons/file';
import FileArchive from 'lucide-solid/icons/file-archive';
import FileCode from 'lucide-solid/icons/file-code';
import FileImage from 'lucide-solid/icons/file-image';
import FileJson from 'lucide-solid/icons/file-json';
import FileSymlink from 'lucide-solid/icons/file-symlink';
import FileTerminal from 'lucide-solid/icons/file-terminal';
import FileText from 'lucide-solid/icons/file-text';
import FileType from 'lucide-solid/icons/file-type';
import Folder from 'lucide-solid/icons/folder';
import { splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../../primitives/internal/cx.ts';
import type { IconComponent } from '../../primitives/internal/icon.ts';
import styles from './FileIcon.module.css';
import { iconKind, type IconKind } from './format.ts';
import type { FileEntry } from './types.ts';

const GLYPHS: Record<IconKind, IconComponent> = {
  folder: Folder,
  text: FileText,
  code: FileCode,
  image: FileImage,
  pdf: FileType,
  archive: FileArchive,
  script: FileTerminal,
  json: FileJson,
  link: FileSymlink,
  other: File,
};

export interface FileIconProps {
  entry: Pick<FileEntry, 'type' | 'name'>;
  /** Pixel size of the glyph. */
  size?: number;
  class?: string;
}

/** A decorative kind glyph; folders are filled with the accent like the dock's Files icon. */
export function FileIcon(props: FileIconProps): JSX.Element {
  const [local] = splitProps(props, ['entry', 'size', 'class']);
  const kind = (): IconKind => iconKind(local.entry);
  return (
    <span class={cx(styles.icon, local.class)} data-kind={kind()} aria-hidden="true">
      <Dynamic
        component={GLYPHS[kind()]}
        size={local.size ?? 16}
        stroke-width={(local.size ?? 16) > 24 ? 1.4 : 1.8}
      />
    </span>
  );
}
