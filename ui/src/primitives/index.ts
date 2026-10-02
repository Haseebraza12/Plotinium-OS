// @plotinium/ui primitives: accessible, themed building blocks (specs/05-wm/visual-language-macos.md §3.8).
export {
  Avatar,
  colourSlotOf,
  initialsOf,
  type AvatarProps,
  type AvatarStatus,
} from './avatar/Avatar.tsx';
export { Badge, Pill, type BadgeProps, type PillProps, type Tone } from './badge/Badge.tsx';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './button/Button.tsx';
export { Checkbox, type CheckboxProps } from './checkbox/Checkbox.tsx';
export { Dialog, type DialogProps, type ModalCloseReason } from './dialog/Dialog.tsx';
export { EmptyState, type EmptyStateProps } from './empty-state/EmptyState.tsx';
export {
  IconButton,
  type IconButtonProps,
  type IconButtonVariant,
} from './icon-button/IconButton.tsx';
export { ariaKeyShortcuts, Kbd, spokenKeys, type KbdProps } from './kbd/Kbd.tsx';
export { ListGroup, ListRow, type ListGroupProps, type ListRowProps } from './list/List.tsx';
export {
  ContextMenu,
  Menu,
  type ContextMenuProps,
  type MenuCloseReason,
  type MenuEntry,
  type MenuHeaderEntry,
  type MenuItemEntry,
  type MenuProps,
  type MenuSeparatorEntry,
} from './menu/Menu.tsx';
export { Popover, type PopoverCloseReason, type PopoverProps } from './popover/Popover.tsx';
export { ProgressBar, type ProgressBarProps, type ProgressTone } from './progress/ProgressBar.tsx';
export { ProgressRing, type ProgressRingProps } from './progress/ProgressRing.tsx';
export { SearchField, type SearchFieldProps } from './search-field/SearchField.tsx';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentOption,
} from './segmented-control/SegmentedControl.tsx';
export { Select, type SelectOption, type SelectProps } from './select/Select.tsx';
export { Sheet, type SheetProps } from './sheet/Sheet.tsx';
export {
  SidebarList,
  type SidebarItem,
  type SidebarListProps,
  type SidebarSection,
  type Tint,
} from './sidebar/SidebarList.tsx';
export { Slider, type SliderProps } from './slider/Slider.tsx';
export { Spinner, type SpinnerProps } from './spinner/Spinner.tsx';
export {
  sortRows,
  Table,
  type SelectionMode,
  type SortDirection,
  type SortState,
  type TableColumn,
  type TableProps,
} from './table/Table.tsx';
export { Tabs, type TabItem, type TabsProps } from './tabs/Tabs.tsx';
export { TextField, type TextFieldProps } from './text-field/TextField.tsx';
export { Toggle, type ToggleProps } from './toggle/Toggle.tsx';
export { Tooltip, type TooltipProps } from './tooltip/Tooltip.tsx';

// Building blocks for shell and app components in this package.
export {
  computePosition,
  createDismissableLayer,
  createPresence,
  cx,
  Floating,
  focusableIn,
  focusInitial,
  prefersReducedMotion,
  rememberFocus,
  trapTabKey,
  type ClassValue,
  type FloatingProps,
  type IconComponent,
  type Placement,
  type Position,
  type Presence,
  type PresenceState,
  type Rect,
} from './internal/index.ts';
