// How everything outside the pane opens Lumopolis: one window event, with an optional folder.
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { childFolder, folderName, folderOfEvent, openLumopolis, OPEN_WORLD_EVENT, useWorldPane } from '../../../src/renderer/src/components/World/worldOpen'

describe('openLumopolis', () => {
  it('dispatches the open event, carrying the folder only when one is given', () => {
    const seen: Array<unknown> = []
    const on = (e: Event): void => { seen.push((e as CustomEvent).detail) }
    window.addEventListener(OPEN_WORLD_EVENT, on)
    openLumopolis()
    openLumopolis('/repo/app')
    window.removeEventListener(OPEN_WORLD_EVENT, on)
    expect(seen).toEqual([null, { folder: '/repo/app' }])
  })
})

describe('folderName', () => {
  it('names a folder by its last part, with or without a trailing separator', () => {
    expect(folderName('C:\\repos\\termpolis')).toBe('termpolis')
    expect(folderName('/home/me/app/')).toBe('app')
  })
  it('names a drive or the root by itself', () => {
    expect(folderName('C:\\')).toBe('C:\\')
    expect(folderName('C:')).toBe('C:\\')
    expect(folderName('/')).toBe('/')
  })
})

describe('childFolder', () => {
  it('joins with the separator the folder already uses', () => {
    expect(childFolder('C:\\repo', 'src')).toBe('C:\\repo\\src')
    expect(childFolder('C:\\', 'src')).toBe('C:\\src')
    expect(childFolder('/home/me/', 'app')).toBe('/home/me/app')
    expect(childFolder('/', 'usr')).toBe('/usr')
    expect(childFolder('C:/repo', 'src')).toBe('C:/repo/src')
  })
})

describe('folderOfEvent', () => {
  it('reads a non-blank folder string and nothing else', () => {
    expect(folderOfEvent(new CustomEvent('x', { detail: { folder: '/a' } }))).toBe('/a')
    expect(folderOfEvent(new CustomEvent('x', { detail: { folder: '  ' } }))).toBeUndefined()
    expect(folderOfEvent(new CustomEvent('x', { detail: { folder: 3 } }))).toBeUndefined()
    expect(folderOfEvent(new CustomEvent('x', { detail: 'a' }))).toBeUndefined()
    expect(folderOfEvent(new Event('x'))).toBeUndefined()
  })
})

describe('useWorldPane', () => {
  it('opens on a plain event following the terminal, and on a folder event with a fresh request each time', () => {
    const { result } = renderHook(() => useWorldPane())
    expect(result.current.show).toBe(false)
    act(() => openLumopolis())
    expect(result.current.show).toBe(true)
    expect(result.current.request).toBeUndefined()
    act(() => openLumopolis('/a'))
    expect(result.current.request).toEqual({ folder: '/a', seq: 1 })
    act(() => openLumopolis('/a'))
    expect(result.current.request).toEqual({ folder: '/a', seq: 2 })
  })

  it('closing, or toggling it off, forgets the request; toggling on and open() keep following', () => {
    const { result } = renderHook(() => useWorldPane())
    act(() => openLumopolis('/a'))
    act(() => result.current.toggle())
    expect(result.current.show).toBe(false)
    expect(result.current.request).toBeUndefined()
    act(() => result.current.toggle())
    expect(result.current.show).toBe(true)
    expect(result.current.request).toBeUndefined()
    act(() => openLumopolis('/b'))
    act(() => result.current.close())
    expect(result.current).toMatchObject({ show: false, request: undefined })
    act(() => result.current.open())
    expect(result.current).toMatchObject({ show: true, request: undefined })
  })

  it('stops listening when unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useWorldPane())
    unmount()
    expect(remove).toHaveBeenCalledWith(OPEN_WORLD_EVENT, expect.any(Function))
    remove.mockRestore()
  })
})
