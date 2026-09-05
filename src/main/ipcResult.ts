/**
 * The envelope every `ipcMain.handle` in this app answers with.
 *
 * Lifted out of `index.ts` so a module that registers its own IPC can answer in
 * the same shape without importing the 3,700-line main entry -- which would pull
 * the whole app in at import time and make that module untestable.
 *
 * Deliberately un-annotated returns: these are the exact inferred types the two
 * private helpers in `index.ts` had, so moving them here changes no call site
 * among the ~280 that already use them.
 */

export function ok<T>(data?: T) {
  return { success: true, data }
}

export function err(error: string) {
  return { success: false, error }
}
