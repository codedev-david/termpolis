/**
 * The routes the app has, and what each one is opened with.
 *
 * Kept apart from `App.tsx` so a screen can type its own navigation without
 * importing the navigator that renders it -- which would be a cycle, since the
 * navigator imports every screen.
 *
 * `Terminal` carries the name as well as the id so the header can be titled
 * before the list has been refreshed. The id is the only part the desktop is
 * ever asked about; the name is a label the phone already holds.
 *
 * `Desktops` and `Pair` both exist in the paired stack: a phone may be paired
 * with several desktops, so pairing another is something it does from inside
 * the app rather than only from the empty state.
 */
export type RootStackParamList = {
  Pair: undefined
  Terminals: undefined
  Terminal: { terminalId: string; name: string }
  SafetyNumber: undefined
  Settings: undefined
  Desktops: undefined
}
