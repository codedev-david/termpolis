// The "watch it grow" toast: a polite live region inside the viewer's container.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChangeToast, TOAST_MS } from '../../../src/renderer/src/world/engine/changeToast'
import { THEMES } from '../../../src/renderer/src/world/engine/themes'

let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const toastEl = (): HTMLElement | null => host.querySelector('.lw-toast')

describe('createChangeToast', () => {
  it('shows the text in a polite live region for about 3 s, styled from the theme', () => {
    const toast = createChangeToast(host)
    expect(toastEl()).toBeNull() // nothing until the first change
    toast.show('+2 parts', THEMES.neon)
    const el = toastEl() as HTMLElement
    expect(el.textContent).toBe('+2 parts')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.hidden).toBe(false)
    expect(el.style.pointerEvents).toBe('none')
    expect(el.style.color).toBe('rgb(226, 232, 240)') // neon text #e2e8f0
    expect(TOAST_MS).toBe(3000)
    vi.advanceTimersByTime(TOAST_MS - 1)
    expect(el.hidden).toBe(false)
    vi.advanceTimersByTime(1)
    // Hidden and emptied, but kept: the live region stays in place for the next announcement.
    expect(el.hidden).toBe(true)
    expect(el.textContent).toBe('')
    expect(toastEl()).toBe(el)
  })

  it('a later show replaces the text and restarts the clock; an empty one hides it at once', () => {
    const toast = createChangeToast(host)
    toast.show('+1 part', THEMES.neon)
    vi.advanceTimersByTime(2000)
    toast.show('2 changed', THEMES.glass)
    const el = toastEl() as HTMLElement
    expect(el.textContent).toBe('2 changed')
    expect(host.querySelectorAll('.lw-toast')).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(el.hidden).toBe(false) // the first timer was replaced
    toast.show('', THEMES.neon)
    expect(el.hidden).toBe(true)
    expect(el.textContent).toBe('')
    vi.advanceTimersByTime(TOAST_MS)
    expect(el.hidden).toBe(true)
  })

  it('puts itself back when the container was redrawn under it (the 2D list replaces its contents)', () => {
    const toast = createChangeToast(host)
    toast.show('+1 part', THEMES.neon)
    host.innerHTML = '<section class="world-fallback"></section>'
    expect(toastEl()).toBeNull()
    toast.show('1 removed', THEMES.neon)
    expect(toastEl()?.textContent).toBe('1 removed')
  })

  it('sits above the ask bar and centred in what the legend leaves free, before and after it first shows (film bug 9)', () => {
    const toast = createChangeToast(host)
    toast.place(80, 244) // before the first show: kept for when the region is made
    toast.show('+1 part', THEMES.neon)
    const el = toastEl() as HTMLElement
    expect(el.style.bottom).toBe('80px')
    expect(el.style.left).toBe('calc(50% - 122px)')
    expect(el.style.maxWidth).toBe('calc(100% - 268px)')
    // Above every panel of the view, so nothing drawn later covers it.
    expect(Number(el.style.zIndex)).toBeGreaterThan(5)
    toast.place(0, 0) // no ask bar, no legend: 16 px off the bottom edge, centred
    expect(el.style.bottom).toBe('16px')
    expect(el.style.left).toBe('calc(50% - 0px)')
    expect(el.style.maxWidth).toBe('calc(100% - 24px)')
    expect(el.style.overflow).toBe('hidden')
    expect(el.style.textOverflow).toBe('ellipsis')
  })

  it('dispose removes it and stops its timer', () => {
    const toast = createChangeToast(host)
    toast.dispose() // nothing shown yet: still fine
    toast.show('+1 part', THEMES.neon)
    toast.dispose()
    expect(toastEl()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
