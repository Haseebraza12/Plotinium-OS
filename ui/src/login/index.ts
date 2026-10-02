// @plotinium/ui login and lock screen (BOOT-14, OFF-03). Presentational (SYS-01): the password
// leaves the component only through onSubmit; sessions, verifiers and power are the caller's.
export {
  formatLockClock,
  formatWait,
  LoginScreen,
  type LoginA11y,
  type LoginA11ySetting,
  type LoginScreenProps,
  type LoginState,
  type LoginStatus,
  type LoginUser,
  type LoginUserKind,
} from './LoginScreen.tsx';
