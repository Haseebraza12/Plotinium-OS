// Settings views (ui-design-system.md §3.8.14; docs/design/stitch/settings-*).
export { NOT_AVAILABLE, UNAVAILABLE_SETTINGS, unavailableNote } from './availability.ts';
export {
  Banner,
  Group,
  NavRow,
  Row,
  SelectRow,
  SliderRow,
  ToggleRow,
  ValueRow,
} from './controls.tsx';
export type * from './models.ts';
export { AboutPane, type AboutPaneProps } from './panes/AboutPane.tsx';
export { ACCENTS, AppearancePane, type AppearancePaneProps } from './panes/AppearancePane.tsx';
export {
  DesktopDockPane,
  formatSize,
  GeneralPane,
  NetworkPane,
  StoragePane,
  UpdatesPane,
  UsersPane,
  type DesktopDockPaneProps,
  type GeneralPaneProps,
  type NetworkPaneProps,
  type StoragePaneProps,
  type UpdatesPaneProps,
  type UsersPaneProps,
} from './panes/GeneralPanes.tsx';
export { PrivacyPane, type PrivacyPaneProps } from './panes/PrivacyPane.tsx';
export {
  MemoryPane,
  SchedulerPane,
  type MemoryPaneProps,
  type SchedulerPaneProps,
} from './panes/SystemPanes.tsx';
export { searchSections, SECTIONS, sectionMeta, type SectionMeta } from './sections.ts';
export { SettingsSidebar, type SettingsSidebarProps } from './SettingsSidebar.tsx';
export { SettingsView, type SettingsViewProps } from './SettingsView.tsx';
