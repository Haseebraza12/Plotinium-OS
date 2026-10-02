// Editor views for apps/editor: CodeMirror 6 wrapper, tabs, banners, lock chip and status bar.
export {
  CodeEditor,
  type CodeEditorHandle,
  type CodeEditorProps,
  type CursorPosition,
  type EditorLanguage,
} from './CodeEditor.tsx';
export {
  classForTag,
  plotiniumEditorTheme,
  plotiniumHighlighter,
  SYNTAX_CLASSES,
} from './theme.ts';
export {
  DocumentTabs,
  tabAccessibleName,
  type DocumentTab,
  type DocumentTabActivity,
  type DocumentTabsProps,
  type DocumentTabState,
} from './DocumentTabs.tsx';
export {
  ConflictBanner,
  conflictTitle,
  EditorBanner,
  type BannerAction,
  type BannerTone,
  type ConflictAction,
  type ConflictBannerProps,
  type ConflictState,
  type EditorBannerProps,
} from './EditorBanner.tsx';
export {
  LEASE_WARNING_SECONDS,
  LockChip,
  lockChipLabel,
  lockChipText,
  type LockChipProps,
  type LockState,
} from './LockChip.tsx';
export {
  EditorStatusBar,
  saveText,
  syncText,
  type EditorStatusBarProps,
  type SaveState,
  type SyncState,
} from './EditorStatusBar.tsx';
export { EditorSidebar, type EditorSidebarProps, type SidebarFile } from './EditorSidebar.tsx';
export { EditorApp, type EditorAppProps, type EditorDocument } from './EditorApp.tsx';
export {
  activeHeading,
  conflictedCopyName,
  languageBadge,
  languageLabel,
  languageOf,
  leaseSecondsLeft,
  markdownOutline,
  type OutlineHeading,
} from './format.ts';
