import { utf8Decode, utf8Encode } from '../src/wire/bytes'
import type { AgentStatus, Capabilities, OutputChunk, RemoteEnvelope } from '../src/wire/protocol'
import { MAX_REQUEST_BYTES, RemoteSession, type RemoteSessionDeps } from '../src/net/remoteSession'

interface Harness {
  session: RemoteSession
  sent: RemoteEnvelope[]
  clock: { value: number }
  advance(ms: number): void
}

function harness(overrides: Partial<RemoteSessionDeps> = {}): Harness {
  const sent: RemoteEnvelope[] = []
  const clock = { value: 0 }
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1

  const deps: RemoteSessionDeps = {
    send: (plaintext) => sent.push(JSON.parse(utf8Decode(plaintext))),
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: clock.value + ms, fn })
      return id
    },
    clearTimer: (t) => {
      timers.delete(t as number)
    },
    ...overrides,
  }

  return {
    session: new RemoteSession(deps),
    sent,
    clock,
    advance(ms) {
      clock.value += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock.value) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
  }
}

function frame(message: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(message))
}

describe('request correlation', () => {
  it('resolves with the data of the matching ok', async () => {
    const h = harness()
    const pending = h.session.request({ kind: 'listTerminals' })
    expect(h.sent[0]).toEqual({ id: 1, request: { kind: 'listTerminals' } })

    h.session.handleFrame(frame({ kind: 'ok', id: 1, data: { terminals: [] } }))
    await expect(pending).resolves.toEqual({ terminals: [] })
  })

  it('rejects with the message of a matching error', async () => {
    const h = harness()
    const pending = h.session.request({ kind: 'createTerminal', name: 'build' })
    h.session.handleFrame(frame({ kind: 'error', id: 1, message: 'capability not granted' }))
    await expect(pending).rejects.toThrow('capability not granted')
  })

  it('gives each request its own id', () => {
    const h = harness()
    void h.session.request({ kind: 'listTerminals' }).catch(() => {})
    void h.session.request({ kind: 'listTerminals' }).catch(() => {})
    void h.session.request({ kind: 'listTerminals' }).catch(() => {})
    expect(h.sent.map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('resolves concurrent requests to their own answers, not to each other', async () => {
    // The failure this guards against is a first-in-first-out queue, which is
    // right until the desktop answers out of order -- and then every terminal on
    // screen shows another terminal's output, permanently.
    const h = harness()
    const first = h.session.request<{ n: number }>({ kind: 'listTerminals' })
    const second = h.session.request<{ n: number }>({ kind: 'listTerminals' })

    h.session.handleFrame(frame({ kind: 'ok', id: 2, data: { n: 2 } }))
    h.session.handleFrame(frame({ kind: 'ok', id: 1, data: { n: 1 } }))

    await expect(first).resolves.toEqual({ n: 1 })
    await expect(second).resolves.toEqual({ n: 2 })
  })

  it('drops an ok for an id nobody is waiting on', () => {
    const h = harness()
    expect(() => h.session.handleFrame(frame({ kind: 'ok', id: 99, data: null }))).not.toThrow()
  })

  it('drops an error for an id nobody is waiting on', () => {
    // An unmatched error must not become an unhandled rejection: on React Native
    // that is a red screen in development and a silent crash in release.
    const h = harness()
    expect(() =>
      h.session.handleFrame(frame({ kind: 'error', id: 99, message: 'nope' })),
    ).not.toThrow()
  })

  it('answers each id once, so a duplicate response is dropped', () => {
    const h = harness()
    void h.session.request({ kind: 'listTerminals' }).catch(() => {})
    h.session.handleFrame(frame({ kind: 'ok', id: 1, data: 'first' }))
    expect(() => h.session.handleFrame(frame({ kind: 'ok', id: 1, data: 'second' }))).not.toThrow()
  })
})

describe('timeouts', () => {
  it('rejects a request nothing ever answers', async () => {
    const h = harness()
    const pending = h.session.request({ kind: 'listTerminals' }, 5_000)
    h.advance(5_000)
    await expect(pending).rejects.toThrow(/timed out/i)
  })

  it('drops a response that arrives after its timeout', async () => {
    // The desktop was asleep, not gone. The answer is real and simply too late,
    // and settling an already-rejected promise must not throw out of the frame
    // handler and take the connection with it.
    const h = harness()
    const pending = h.session.request({ kind: 'listTerminals' }, 5_000)
    h.advance(5_000)
    await expect(pending).rejects.toThrow()
    expect(() => h.session.handleFrame(frame({ kind: 'ok', id: 1, data: 'late' }))).not.toThrow()
  })

  it('clears the timer once an answer arrives', async () => {
    const h = harness()
    const pending = h.session.request({ kind: 'listTerminals' }, 5_000)
    h.session.handleFrame(frame({ kind: 'ok', id: 1, data: 'quick' }))
    await expect(pending).resolves.toBe('quick')
    expect(() => h.advance(60_000)).not.toThrow()
  })
})

describe('pushes', () => {
  const chunks: OutputChunk[] = [
    { terminalId: 't1', chunk: 'npm test\r\n', missed: 0, marker: null },
    { terminalId: 't2', chunk: 'ok\r\n', missed: 12, marker: '[12 chars lost]' },
  ]

  it('routes an output batch to every output subscriber', () => {
    const h = harness()
    const seen: OutputChunk[][] = []
    h.session.onOutput((c) => seen.push(c))
    h.session.onOutput((c) => seen.push(c))

    h.session.handleFrame(frame({ kind: 'output', chunks }))
    expect(seen).toEqual([chunks, chunks])
  })

  it('does not resolve a pending request with an unsolicited push', async () => {
    const h = harness()
    let settled = false
    void h.session
      .request({ kind: 'listTerminals' })
      .then(() => {
        settled = true
      })
      .catch(() => {
        settled = true
      })

    h.session.handleFrame(frame({ kind: 'output', chunks }))
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it('routes a status push to status subscribers', () => {
    const h = harness()
    const seen: { terminalId: string; status: AgentStatus; summary: string }[] = []
    h.session.onStatus((s) => seen.push(s))

    h.session.handleFrame(
      frame({ kind: 'status', terminalId: 't1', status: 'waiting_for_input', summary: 'approve?' }),
    )
    expect(seen).toEqual([
      { terminalId: 't1', status: 'waiting_for_input', summary: 'approve?' },
    ])
  })

  it('routes a capability push to capability subscribers', () => {
    const h = harness()
    const seen: Capabilities[] = []
    h.session.onCapabilities((c) => seen.push(c))
    h.session.onCapabilities((c) => seen.push(c))

    h.session.handleFrame(
      frame({ kind: 'capabilities', capabilities: { read: true, closeTerminal: true } }),
    )
    const expected = {
      read: true,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: true,
    }
    expect(seen).toEqual([expected, expected])
  })

  it('delivers a push that revokes everything', () => {
    // The withdrawal is the whole point of the push: a phone that ignored it
    // would keep offering a control the user just took away.
    const h = harness()
    const seen: Capabilities[] = []
    h.session.onCapabilities((c) => seen.push(c))
    h.session.handleFrame(frame({ kind: 'capabilities', capabilities: {} }))
    expect(seen).toEqual([
      { read: false, createTerminal: false, writeToTerminal: false, closeTerminal: false },
    ])
  })

  it('does not resolve a pending request with a capability push', async () => {
    // The pull and the push carry the same record. They must not be confused:
    // a push arriving mid-request would otherwise answer the wrong question.
    const h = harness()
    let settled = false
    void h.session
      .request({ kind: 'getCapabilities' })
      .then(() => {
        settled = true
      })
      .catch(() => {
        settled = true
      })

    h.session.handleFrame(frame({ kind: 'capabilities', capabilities: { read: true } }))
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it('stops delivering once a capability subscriber unsubscribes', () => {
    const h = harness()
    const seen: Capabilities[] = []
    const off = h.session.onCapabilities((c) => seen.push(c))
    h.session.handleFrame(frame({ kind: 'capabilities', capabilities: { read: true } }))
    off()
    h.session.handleFrame(frame({ kind: 'capabilities', capabilities: {} }))
    expect(seen).toHaveLength(1)
  })

  it('keeps delivering capabilities to the other subscribers when one throws', () => {
    const h = harness()
    const seen: Capabilities[] = []
    h.session.onCapabilities(() => {
      throw new Error('a bad render')
    })
    h.session.onCapabilities((c) => seen.push(c))

    expect(() =>
      h.session.handleFrame(frame({ kind: 'capabilities', capabilities: { read: true } })),
    ).not.toThrow()
    expect(seen).toHaveLength(1)
  })

  it('stops delivering once a subscriber unsubscribes', () => {
    const h = harness()
    const seen: OutputChunk[][] = []
    const off = h.session.onOutput((c) => seen.push(c))
    h.session.handleFrame(frame({ kind: 'output', chunks }))
    off()
    h.session.handleFrame(frame({ kind: 'output', chunks }))
    expect(seen).toHaveLength(1)
  })

  it('unsubscribing twice is harmless', () => {
    const h = harness()
    const off = h.session.onOutput(() => {})
    off()
    expect(() => off()).not.toThrow()
  })

  it('keeps delivering to the other subscribers when one throws', () => {
    // A render callback that throws must not deafen the rest of the app to
    // terminal output for the remainder of the session.
    const h = harness()
    const seen: OutputChunk[][] = []
    h.session.onOutput(() => {
      throw new Error('a bad render')
    })
    h.session.onOutput((c) => seen.push(c))

    expect(() => h.session.handleFrame(frame({ kind: 'output', chunks }))).not.toThrow()
    expect(seen).toEqual([chunks])
  })
})

describe('handleFrame never throws', () => {
  const hostile = [
    '',
    '   ',
    'not json at all',
    'null',
    '42',
    '"a bare string"',
    '[]',
    '[{"kind":"ok","id":1,"data":null}]',
    '{}',
    '{"kind":null}',
    '{"kind":"ok"}',
    '{"kind":"ok","id":"1","data":null}',
    '{"kind":"error","id":1}',
    '{"kind":"output"}',
    '{"kind":"output","chunks":null}',
    '{"kind":"output","chunks":[{"terminalId":1}]}',
    '{"kind":"status","terminalId":"t1"}',
    '{"kind":"unheard-of"}',
    '{"__proto__":{"polluted":true},"kind":"ok","id":1,"data":null}',
  ]

  it.each(hostile)('survives %j', (text) => {
    const h = harness()
    void h.session.request({ kind: 'listTerminals' }).catch(() => {})
    expect(() => h.session.handleFrame(utf8Encode(text))).not.toThrow()
  })

  it('survives a megabyte of junk', () => {
    const h = harness()
    expect(() => h.session.handleFrame(utf8Encode('x'.repeat(1_048_576)))).not.toThrow()
  })

  it('survives bytes that are not valid UTF-8', () => {
    const h = harness()
    expect(() => h.session.handleFrame(Uint8Array.from([0xff, 0xfe, 0xfd]))).not.toThrow()
  })

  it('leaves no prototype pollution behind', () => {
    const h = harness()
    h.session.handleFrame(utf8Encode('{"__proto__":{"polluted":true},"kind":"output"}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('the local size limit', () => {
  it('leaves room for the frame tag and the seal overhead', () => {
    // 1 MiB on the wire, minus the one-byte tag and the 22 bytes of counter and
    // Poly1305 tag that sealing adds.
    expect(MAX_REQUEST_BYTES).toBe(1_048_576 - 1 - 22)
  })

  it('refuses an oversized request locally instead of sending it', async () => {
    // The relay CUTS a connection over an oversized frame rather than truncating
    // it, and the cut latches. Sending one turns a paste that was too big into a
    // remote session that never comes back, which reads to the user as an
    // unreliable network rather than as one message being too large.
    const h = harness()
    const pending = h.session.request({
      kind: 'writeToTerminal',
      terminalId: 't1',
      text: 'x'.repeat(MAX_REQUEST_BYTES),
    })
    await expect(pending).rejects.toThrow(/too large/i)
    expect(h.sent).toHaveLength(0)
  })

  it('measures UTF-8 bytes, not characters', async () => {
    // A limit measured in string length passes a paste of emoji that is four
    // times over on the wire.
    const h = harness()
    const text = '🙂'.repeat(Math.ceil(MAX_REQUEST_BYTES / 4))
    await expect(
      h.session.request({ kind: 'writeToTerminal', terminalId: 't1', text }),
    ).rejects.toThrow(/too large/i)
    expect(h.sent).toHaveLength(0)
  })

  it('sends a request that just fits', async () => {
    const h = harness()
    const overhead = utf8Encode(
      JSON.stringify({ id: 1, request: { kind: 'writeToTerminal', terminalId: 't1', text: '' } }),
    ).length
    const pending = h.session.request({
      kind: 'writeToTerminal',
      terminalId: 't1',
      text: 'x'.repeat(MAX_REQUEST_BYTES - overhead),
    })
    expect(h.sent).toHaveLength(1)
    h.session.handleFrame(frame({ kind: 'ok', id: 1, data: null }))
    await expect(pending).resolves.toBeNull()
  })

  it('does not burn an id on a request it refused to send', async () => {
    // Ids are the correlation key. Skipping one is harmless; the reason to check
    // is that a refusal must not leave a pending entry behind either.
    const h = harness()
    await expect(
      h.session.request({ kind: 'writeToTerminal', terminalId: 't1', text: 'x'.repeat(2_000_000) }),
    ).rejects.toThrow()
    const pending = h.session.request({ kind: 'listTerminals' })
    h.session.handleFrame(frame({ kind: 'ok', id: h.sent[0]!.id, data: 'ok' }))
    await expect(pending).resolves.toBe('ok')
  })
})

describe('teardown', () => {
  it('rejects everything still in flight when the session is dropped', async () => {
    // A phone that backgrounds mid-request comes back to a screen that has been
    // spinning since it left, unless the pending set is failed on the way out.
    const h = harness()
    const pending = h.session.request({ kind: 'listTerminals' })
    h.session.reset('the desktop went away')
    await expect(pending).rejects.toThrow('the desktop went away')
  })

  it('is usable again after a reset', async () => {
    const h = harness()
    void h.session.request({ kind: 'listTerminals' }).catch(() => {})
    h.session.reset('gone')
    const pending = h.session.request({ kind: 'listTerminals' })
    h.session.handleFrame(frame({ kind: 'ok', id: h.sent[1]!.id, data: 'back' }))
    await expect(pending).resolves.toBe('back')
  })

  it('keeps subscribers across a reset', () => {
    // The socket reconnects underneath; the screen listening for output does not
    // re-mount, and re-subscribing on every reconnect is how listeners multiply.
    const h = harness()
    const seen: OutputChunk[][] = []
    h.session.onOutput((c) => seen.push(c))
    h.session.reset('gone')
    h.session.handleFrame(frame({ kind: 'output', chunks: [] }))
    expect(seen).toHaveLength(1)
  })
})

describe('unsubscribing from a stream', () => {
  it('stops delivering status updates once the caller lets go', () => {
    // The screen subscribes on mount and lets go on unmount. A returned
    // unsubscribe that did not actually unseat the callback would keep a
    // React state setter alive on a screen that is gone.
    const h = harness()
    const seen: AgentStatus[] = []
    const stop = h.session.onStatus((u) => seen.push(u.status))

    h.session.handleFrame(
      frame({ kind: 'status', terminalId: 't1', status: 'working', summary: 'building' }),
    )
    stop()
    h.session.handleFrame(
      frame({ kind: 'status', terminalId: 't1', status: 'idle', summary: 'done' }),
    )

    expect(seen).toEqual(['working'])
  })

  it('stops delivering output once the caller lets go', () => {
    const h = harness()
    const seen: OutputChunk[][] = []
    const stop = h.session.onOutput((chunks) => seen.push(chunks))

    h.session.handleFrame(
      frame({ kind: 'output', chunks: [{ terminalId: 't1', chunk: 'one', missed: 0, marker: null }] }),
    )
    stop()
    h.session.handleFrame(
      frame({ kind: 'output', chunks: [{ terminalId: 't1', chunk: 'two', missed: 0, marker: null }] }),
    )

    expect(seen).toHaveLength(1)
  })

  it('stops delivering capability changes once the caller lets go', () => {
    const h = harness()
    const seen: Capabilities[] = []
    const stop = h.session.onCapabilities((caps) => seen.push(caps))
    const caps: Capabilities = {
      read: true,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: false,
    }

    h.session.handleFrame(frame({ kind: 'capabilities', capabilities: caps }))
    stop()
    h.session.handleFrame(frame({ kind: 'capabilities', capabilities: caps }))

    expect(seen).toHaveLength(1)
  })
})
