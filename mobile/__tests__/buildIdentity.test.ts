import { formatBuildIdentity } from '../src/app/buildIdentity'

describe('formatBuildIdentity -- telling one binary from another', () => {
  it('reports the embedded iOS build, not app.json', () => {
    // app.json pins ios.buildNumber to "1" forever while EAS increments the real
    // CFBundleVersion remotely. Reading the embedded plist is the whole point:
    // reading app.json would print "1" for every build ever shipped.
    expect(
      formatBuildIdentity({
        expoConfig: { version: '1.0.0' },
        platform: { ios: { buildNumber: '7' } },
      }),
    ).toBe('1.0.0 (build 7)')
  })

  it('reports the Android version code', () => {
    expect(
      formatBuildIdentity({
        expoConfig: { version: '1.0.0' },
        platform: { android: { versionCode: 12 } },
      }),
    ).toBe('1.0.0 (build 12)')
  })

  it('says so when the build is unknown rather than implying build 0', () => {
    // Expo Go and the dev client report no build number. Printing a bare
    // version there would look like a real answer to the one question this
    // string exists to answer.
    expect(formatBuildIdentity({ expoConfig: { version: '1.0.0' }, platform: {} })).toBe(
      '1.0.0 (build unknown)',
    )
    expect(formatBuildIdentity({})).toBe('unknown (build unknown)')
    expect(
      formatBuildIdentity({ expoConfig: { version: '1.0.0' }, platform: { ios: { buildNumber: '' } } }),
    ).toBe('1.0.0 (build unknown)')
  })
})
