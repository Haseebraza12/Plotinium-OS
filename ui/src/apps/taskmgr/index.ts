// Task Manager views (ui-design-system.md §3.8.13; docs/design/stitch/task-manager-*).
export { AiPanel, type AiPanelProps } from './AiPanel.tsx';
export { BudgetBar, type BudgetBarProps } from './BudgetBar.tsx';
export {
  agingBound,
  bandOf,
  basePriority,
  canEnd,
  formatBytes,
  formatMB,
  frameTone,
  matchesQuery,
  sparkPath,
  stateName,
  type BoundParams,
} from './format.ts';
export {
  budgetLevel,
  MemoryPanel,
  type BudgetLevel,
  type MemoryPanelProps,
} from './MemoryPanel.tsx';
export type * from './models.ts';
export { PredictionsPanel, type PredictionsPanelProps } from './PredictionsPanel.tsx';
export {
  CONFIRM_MS,
  EndProcessButton,
  KillDialog,
  ReniceButton,
  type EndProcessButtonProps,
  type KillDialogProps,
  type KillRequest,
  type ReniceButtonProps,
} from './ProcessActions.tsx';
export {
  CpuCell,
  FrameCard,
  PerformanceStrip,
  PROCESS_COLUMNS,
  ProcessesPanel,
  ProcessName,
  type ProcessesPanelProps,
  type RowAction,
} from './ProcessesPanel.tsx';
export { SchedulerPanel, type SchedulerPanelProps } from './SchedulerPanel.tsx';
export { Sparkline, type SparklineProps, type SparkTone } from './Sparkline.tsx';
export { StatePill, type StatePillProps } from './StatePill.tsx';
export {
  TASK_MANAGER_TABS,
  TaskManagerView,
  type SettingsLink,
  type TaskManagerViewProps,
} from './TaskManagerView.tsx';
