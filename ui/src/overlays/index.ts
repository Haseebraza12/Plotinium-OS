// @plotinium/ui overlays: Search, Overview, the window switcher, the kernel confirmation sheet,
// Restart to update and the shutdown progress, the connectivity popover, the lease banner and the
// frame meter. Presentational (SYS-01): data in through props, intents out through callbacks.
export {
  AgentConfirmSheet,
  toneOfOp,
  type AgentBlastRadius,
  type AgentCancelReason,
  type AgentConfirmReason,
  type AgentConfirmReasonKind,
  type AgentConfirmSheetProps,
  type AgentConfirmStatus,
  type AgentPlanStep,
  type PlanOpTone,
} from './agent-confirm/AgentConfirmSheet.tsx';
export {
  FrameMeterHUD,
  type FrameMeterCorner,
  type FrameMeterHUDProps,
  type FrameMeterStats,
} from './frame-meter/FrameMeterHUD.tsx';
export {
  AboutAppDialog,
  HelpSheet,
  type AboutAppDialogProps,
  type HelpSheetProps,
  type ShortcutGroup,
  type ShortcutRow,
} from './help/HelpSheet.tsx';
export { LockBanner, type LockBannerProps, type LockBannerState } from './offline/LockBanner.tsx';
export {
  headerFor as offlineHeaderFor,
  OfflinePopover,
  type DegradedService,
  type OfflinePopoverProps,
  type QueuedOp,
  type RetryState,
} from './offline/OfflinePopover.tsx';
export {
  flipFrom,
  Overview,
  overviewColumns,
  type OverviewDesktop,
  type OverviewProps,
  type OverviewSlot,
  type OverviewWindow,
  type OverviewWindowState,
} from './overview/Overview.tsx';
export {
  SEARCH_BUDGET_MS,
  SearchPalette,
  spokenResult,
  type SearchCloseReason,
  type SearchFileKind,
  type SearchGroup,
  type SearchPaletteProps,
  type SearchPreview,
  type SearchPreviewLine,
  type SearchPreviewLineStyle,
  type SearchResult,
  type SearchResultKind,
  type SearchStats,
  type SemanticState,
} from './search/SearchPalette.tsx';
export {
  AppSwitcher,
  spokenSwitcherItem,
  type AppSwitcherProps,
  type SwitcherItem,
} from './switcher/AppSwitcher.tsx';
export {
  codeRuns,
  RestartToUpdateDialog,
  type BuildInfo,
  type RestartToUpdateDialogProps,
  type UpdateNote,
} from './update/RestartToUpdateDialog.tsx';
export {
  ShutdownProgress,
  type ShutdownProgressProps,
  type ShutdownStep,
  type ShutdownStepState,
} from './update/ShutdownProgress.tsx';
