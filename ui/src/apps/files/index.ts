// Files views for apps/files: sidebar, toolbar, list and icon views, semantic results,
// inspector and status bar. Data in through props, intents out through callbacks (SYS-01).
export * from './types.ts';
export {
  citation,
  entrySize,
  extensionOf,
  formatAgo,
  formatDate,
  formatSize,
  highlightRuns,
  iconKind,
  kindLabel,
  modeString,
  permissionString,
  quotaLevel,
  quotaText,
  sortEntries,
  spokenMode,
  type IconKind,
  type QuotaLevel,
} from './format.ts';
export {
  clearSelection,
  clickSelect,
  contextSelect,
  EMPTY_SELECTION,
  keySelect,
  pruneSelection,
  selectAll,
  toggleFocused,
  type Modifiers,
  type NavKey,
  type Selection,
} from './selection.ts';
export { collectionIntent, type CollectionIntent, type KeyInput } from './keys.ts';
export {
  denyReason,
  fileMenuItems,
  menuLabel,
  openWithItems,
  ownsEntry,
  type FileAction,
  type MenuContext,
  type OpenWithTarget,
} from './menu.ts';
export { FileIcon, type FileIconProps } from './FileIcon.tsx';
export { FilesSidebar, quotaStateText, type FilesSidebarProps } from './FilesSidebar.tsx';
export { PathBar, pathSegments, type PathBarProps, type PathSegment } from './PathBar.tsx';
export {
  FilesSearch,
  FilesToolbar,
  type FilesSearchProps,
  type FilesToolbarProps,
} from './FilesToolbar.tsx';
export {
  FileList,
  ROW_HEIGHT,
  rowStatus,
  VIRTUALIZE_AT,
  type CollectionProps,
  type FileListProps,
} from './FileList.tsx';
export { FileGrid } from './FileGrid.tsx';
export {
  hitLabel,
  noticeText,
  SemanticResults,
  type SearchError,
  type SemanticResultsProps,
} from './SemanticResults.tsx';
export { Inspector, lockText, type InspectorAction, type InspectorProps } from './Inspector.tsx';
export {
  FilesStatusBar,
  itemsText,
  quotaWarning,
  searchText,
  type FilesStatusBarProps,
  type SearchStatus,
} from './FilesStatusBar.tsx';
export {
  FilesView,
  type FilesIntent,
  type FilesResults,
  type FilesViewProps,
} from './FilesView.tsx';
