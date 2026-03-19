export function createOutputThrottle(writeFn: (data: string) => void) {
  let buffer = ''
  let scheduled = false

  return (data: string) => {
    buffer += data
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(() => {
        writeFn(buffer)
        buffer = ''
        scheduled = false
      })
    }
  }
}
