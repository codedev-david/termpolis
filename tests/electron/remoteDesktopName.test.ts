import { describe, expect, it } from 'vitest'
import { hostname } from 'os'

import { localDesktopName } from '../../src/main/remoteBridge/desktopName'
import { MAX_DEVICE_LABEL } from '../../src/main/remoteBridge/deviceLabel'

/**
 * What this machine tells a phone to call it.
 *
 * The hostname is the only name the desktop has that its owner already
 * recognises. It is not treated as trustworthy input even so: it is set by
 * whoever installed the machine, it travels to another device, and it is drawn
 * in a list -- which is exactly the shape of thing that should not be able to
 * carry a control character into somebody else's UI.
 */
describe('localDesktopName', () => {
  it('reads the machine name', () => {
    expect(localDesktopName()).toBe(hostname())
  })

  it('cleans and clips what the OS reports', () => {
    expect(localDesktopName(() => '  workshop-linux  ')).toBe('workshop-linux')
    expect(localDesktopName(() => 'h'.repeat(500))).toBe('h'.repeat(MAX_DEVICE_LABEL))
  })

  it('answers with nothing rather than a house name when the OS will not say', () => {
    // A container with no hostname, or a syscall that failed. `sealPairingAck`
    // then leaves the field out entirely and the phone names the desktop
    // itself -- which beats every machine in the list being called "Desktop".
    expect(
      localDesktopName(() => {
        throw new Error('no hostname')
      }),
    ).toBe('')
    expect(localDesktopName(() => '')).toBe('')
  })
})
