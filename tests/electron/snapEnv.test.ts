import { describe, it, expect } from 'vitest'
import { cleanSnapLauncherEnv, snapEnvCleanup, SNAP_LAUNCHER_VARS } from '../../src/main/snapEnv'

const SNAP = '/snap/termpolis/12'
const USER_DATA = '/home/ann/snap/termpolis/12'
const USER_COMMON = '/home/ann/snap/termpolis/common'

/** What electron-builder's launcher scripts leave behind in a classic snap (empty desktop runtime). */
function launched(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: '/home/ann',
    SNAP,
    SNAP_USER_DATA: USER_DATA,
    SNAP_USER_COMMON: USER_COMMON,
    SNAP_NAME: 'termpolis',
    XDG_CONFIG_HOME: `${USER_DATA}/.config`,
    XDG_DATA_HOME: `${USER_DATA}/.local/share`,
    XDG_CACHE_HOME: `${USER_COMMON}/.cache`,
    XDG_DATA_DIRS: `${USER_DATA}/.local/share:${USER_DATA}:${SNAP}/data-dir:${SNAP}/usr/share:/usr/local/share:/usr/share`,
    XDG_CONFIG_DIRS: `${SNAP}/etc/xdg:/etc/xdg`,
    LD_LIBRARY_PATH: '/opt/mine/lib:/usr/lib/x86_64-linux-gnu/mesa:/var/lib/snapd/lib/gl:/usr/lib/x86_64-linux-gnu/pulseaudio',
    LD_PRELOAD: `${SNAP}/lib/bindtextdomain.so`,
    PATH: `/home/ann/bin:/usr/bin:${SNAP}/usr/bin/`,
    LOCPATH: '/usr/lib/locale',
    __EGL_VENDOR_LIBRARY_DIRS: '/var/lib/snapd/lib/glvnd/egl_vendor.d',
    SNAP_DESKTOP_WAYLAND_AVAILABLE: 'true',
    GDK_BACKEND: 'wayland',
    CLUTTER_BACKEND: 'wayland',
    QT_QPA_PLATFORM: 'wayland-egl',
    REALHOME: '/home/ann',
    GTK_PATH: '/usr/lib/x86_64-linux-gnu/gtk-3.0',
    GDK_PIXBUF_MODULE_FILE: `${USER_COMMON}/.cache/gdk-pixbuf-loaders.cache`,
    PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
    ...extra,
  }
  return env
}

describe('cleanSnapLauncherEnv', () => {
  it('does nothing outside a snap', () => {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/x', GTK_PATH: '/y', PATH: '/usr/bin' }
    expect(cleanSnapLauncherEnv(env)).toEqual({ removed: [], trimmed: [], configHomeMoved: false })
    expect(env).toEqual({ XDG_CONFIG_HOME: '/x', GTK_PATH: '/y', PATH: '/usr/bin' })
  })

  it("undoes the launcher: XDG homes back to the user's, launcher variables gone, snap entries out of path lists", () => {
    const env = launched()
    const result = cleanSnapLauncherEnv(env)
    expect(result.configHomeMoved).toBe(true)
    expect(env).toEqual({
      HOME: '/home/ann',
      SNAP,
      SNAP_USER_DATA: USER_DATA,
      SNAP_USER_COMMON: USER_COMMON,
      SNAP_NAME: 'termpolis',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      XDG_CONFIG_DIRS: '/etc/xdg',
      LD_LIBRARY_PATH: '/opt/mine/lib',
      PATH: '/home/ann/bin:/usr/bin',
      PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
    })
    expect(result.trimmed.sort()).toEqual(['LD_LIBRARY_PATH', 'PATH', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS'])
    expect(result.removed).toEqual(expect.arrayContaining(['GDK_BACKEND', 'XDG_CONFIG_HOME', 'REALHOME', 'GTK_PATH', 'LD_PRELOAD', 'LOCPATH', '__EGL_VENDOR_LIBRARY_DIRS']))
  })

  it("keeps the user's own XDG homes and Wayland choices", () => {
    const env = launched({
      XDG_CONFIG_HOME: '/home/ann/.cfg',
      XDG_DATA_HOME: undefined,
      XDG_CACHE_HOME: '',
      SNAP_DESKTOP_WAYLAND_AVAILABLE: undefined,
      GDK_BACKEND: 'wayland',
    })
    const result = cleanSnapLauncherEnv(env)
    expect(result.configHomeMoved).toBe(false)
    expect(env.XDG_CONFIG_HOME).toBe('/home/ann/.cfg')
    expect(env.XDG_CACHE_HOME).toBe('')
    expect(env.GDK_BACKEND).toBe('wayland')
    expect(env.CLUTTER_BACKEND).toBe('wayland')
  })

  it('leaves a Wayland variable alone when it no longer holds what the launcher set', () => {
    const env = launched({ GDK_BACKEND: 'x11' })
    cleanSnapLauncherEnv(env)
    expect(env.GDK_BACKEND).toBe('x11')
    expect(env.QT_QPA_PLATFORM).toBeUndefined()
  })

  it('keeps empty PATH entries and lists with nothing of the snap in them', () => {
    const env = launched({ PATH: '/usr/bin::/bin', LD_LIBRARY_PATH: '/opt/lib' })
    const result = cleanSnapLauncherEnv(env)
    expect(env.PATH).toBe('/usr/bin::/bin')
    expect(env.LD_LIBRARY_PATH).toBe('/opt/lib')
    expect(result.trimmed).not.toContain('PATH')
  })

  it('works with a trailing slash on SNAP and without SNAP_USER_COMMON', () => {
    const env: NodeJS.ProcessEnv = {
      SNAP: `${SNAP}/`,
      SNAP_USER_DATA: USER_DATA,
      XDG_CONFIG_HOME: `${USER_DATA}/.config`,
      XDG_CACHE_HOME: `${USER_COMMON}/.cache`,
      PATH: `${SNAP}/bin:/usr/bin`,
    }
    cleanSnapLauncherEnv(env)
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
    expect(env.XDG_CACHE_HOME).toBe(`${USER_COMMON}/.cache`)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('names only launcher variables that no user program reads', () => {
    expect(SNAP_LAUNCHER_VARS).not.toContain('HOME')
    expect(SNAP_LAUNCHER_VARS).not.toContain('SNAP')
    expect(SNAP_LAUNCHER_VARS).not.toContain('PULSE_SERVER')
  })

  it('does not run in a process that is not a snap (the test runner)', () => {
    expect(snapEnvCleanup).toBeNull()
  })
})
