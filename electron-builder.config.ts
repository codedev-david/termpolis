import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.termpolis.app',
  productName: 'Termpolis',
  directories: { output: 'dist-electron-builder' },
  files: ['out/**/*'],
  extraResources: [
    { from: 'src/mcp-adapter', to: 'mcp-adapter', filter: ['**/*.cjs'] },
  ],
  win: {
    target: 'nsis',
    icon: 'assets/icon.ico',
    extraResources: [{ from: 'resources/tools/win32', to: 'tools', filter: ['**/*'] }],
  },
  mac: {
    // dmg is the user-facing installer; zip is required by electron-updater
    // (Squirrel.Mac uses .zip for the in-place update payload — .dmg needs
    // user interaction to mount + drag). Sentry ELECTRON-6/7 surfaced as
    // "ZIP file not provided" on every macOS auto-update attempt for
    // v1.11.58 because the previous config emitted dmg only.
    target: ['dmg', 'zip'],
    icon: 'assets/icon.png',
    identity: null,
    extraResources: [{ from: 'resources/tools/darwin', to: 'tools', filter: ['**/*'] }],
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'assets/icon.png',
    category: 'Development',
    maintainer: 'Termpolis <support@termpolis.com>',
    extraResources: [{ from: 'resources/tools/linux', to: 'tools', filter: ['**/*'] }],
  },
}

export default config
