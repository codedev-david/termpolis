const MAX_FLUSH_SIZE = 65536 // 64KB per frame — prevents memory spikes from extreme output

export function createOutputThrottle(writeFn: (data: string) => void) {
  let buffer = ''
  let scheduled = false

  function flush() {
    if (buffer.length <= MAX_FLUSH_SIZE) {
      writeFn(buffer)
      buffer = ''
      scheduled = false
    } else {
      // Write up to 64KB, defer the rest to next frame
      writeFn(buffer.slice(0, MAX_FLUSH_SIZE))
      buffer = buffer.slice(MAX_FLUSH_SIZE)
      requestAnimationFrame(flush)
    }
  }

  return (data: string) => {
    buffer += data
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }
}
