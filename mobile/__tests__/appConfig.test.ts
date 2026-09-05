import appConfig from '../app.json'
import pkg from '../package.json'

/**
 * A store disclosure is a claim about code.
 *
 * `ITSAppUsesNonExemptEncryption` can be dropped by a careless `app.json` edit,
 * `blockedPermissions` can be lost when a plugin is added, and "collects no
 * data" stops being true the first time someone installs an analytics SDK. In
 * every case silently, months after the form was signed. These are the cheapest
 * tests here and they guard the most expensive mistake.
 */
describe('app.json -- the fields a store submission turns on', () => {
  const ios = appConfig.expo.ios
  const android = appConfig.expo.android

  it('declares non-exempt encryption', () => {
    // X25519 + HKDF + XChaCha20-Poly1305. Claiming the exemption here would be
    // a false statement on an export-compliance form, not a shortcut.
    expect(ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(true)
  })

  it('keeps the bundle identifiers that were submitted', () => {
    // Not re-assignable after the first submission, on either store.
    expect(ios.bundleIdentifier).toBe('com.termpolis.remote')
    expect(android.package).toBe('com.termpolis.remote')
  })

  it('targets the two platforms that were reviewed, and no third one', () => {
    // Expo defaults to every platform it knows about, web included. Web is not
    // a target here -- the wire code has never been run against a DOM, and a
    // bundle nobody tests is a bundle nobody has checked for a leaked key. With
    // the list pinned, an unqualified `expo export` builds exactly what ships.
    expect(appConfig.expo.platforms).toEqual(['ios', 'android'])
  })

  it('asks Android for the camera and the network, and nothing else', () => {
    expect(android.permissions).toEqual([
      'android.permission.CAMERA',
      'android.permission.INTERNET',
    ])
  })

  it('blocks the permissions expo-camera would otherwise merge in', () => {
    // An app that scans one QR code has no business asking to record audio, and
    // a manifest-merged permission is one nobody remembers requesting.
    expect(android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ]),
    )
  })

  it('explains the camera in the words the permission prompt will use', () => {
    const entry = appConfig.expo.plugins.find((p) => p[0] === 'expo-camera')
    expect(entry).toBeDefined()
    // Matched as an object rather than read as a property: the type app.json
    // gives `plugins` is a union of every plugin's option shape, and narrowing
    // it by hand would be a cast that stops meaning anything the moment a
    // fourth plugin is added.
    //
    // "only to scan the pairing code" -- a prompt that names one purpose is a
    // prompt a reviewer can hold the app to.
    expect(entry?.[1]).toMatchObject({
      cameraPermission: expect.stringMatching(/only to scan the pairing code/i),
    })
  })
})

describe('package.json -- what makes "collects no data" true', () => {
  it('carries exactly the reviewed dependencies', () => {
    // Exact, not a denylist: a denylist only catches the SDKs someone thought
    // of. Adding anything here should send you to
    // mobile/store/data-disclosures.md before it sends you to the store.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@noble/ciphers',
      '@noble/curves',
      '@noble/hashes',
      '@react-navigation/native',
      '@react-navigation/native-stack',
      'expo',
      'expo-camera',
      'expo-constants',
      'expo-secure-store',
      'expo-splash-screen',
      'expo-status-bar',
      'react',
      'react-native',
      'react-native-get-random-values',
      'react-native-safe-area-context',
      'react-native-screens',
      'zustand',
    ])
  })
})
