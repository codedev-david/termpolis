// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screenRect } from '../../../src/renderer/src/world/engine/screenRect'

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('screenRect', () => {
  it('takes the box as measured where the browser has standard zoom (currentCSSZoom)', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    Object.defineProperty(el, 'currentCSSZoom', { value: 1.5 })
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(box(10, 20, 110, 70))
    expect(screenRect(el)).toEqual({ left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 })
  })

  it('on an older Chromium, scales the box by the zoom it is under, its own and every ancestor', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('span')
    outer.appendChild(inner)
    document.body.appendChild(outer)
    const zoomOf = new Map<Element, string>([[outer, '1.5'], [inner, '2']])
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((e: Element) => {
      const cs = real(e)
      return new Proxy(cs, { get: (t, k) => (k === 'zoom' ? zoomOf.get(e) ?? '' : Reflect.get(t, k)) })
    })
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(box(10, 20, 30, 25))
    expect(screenRect(inner)).toEqual({ left: 30, top: 60, right: 90, bottom: 75, width: 60, height: 15 })
    // Nothing zoomed: the box as it is.
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(box(0, 0, 8, 4))
    expect(screenRect(document.body)).toEqual({ left: 0, top: 0, right: 8, bottom: 4, width: 8, height: 4 })
  })
})
