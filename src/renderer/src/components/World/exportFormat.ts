// How the Lumopolis export dialog and its toast write sizes, save times and file names.

const MB = 1024 * 1024

/** A size in MB: one decimal under 10 (never below 0.1), whole numbers above. */
export function formatMb(bytes: number): string {
  const mb = Math.max(0.1, bytes / MB)
  return mb < 9.95 ? mb.toFixed(1) : String(Math.round(mb))
}

/** When the map was saved: its time today, or its day and time before today. */
export function savedAtText(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString()} ${time}`
}

/** The file name at the end of a saved path, Windows or POSIX. */
export const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() as string
