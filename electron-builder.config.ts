import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.termpolis.app',
  productName: 'Termpolis',
  directories: { output: 'dist-electron-builder' },
  files: ['out/**/*'],
  win: {
    target: 'nsis',
    icon: 'assets/icon.ico',
    extraResources: [{ from: 'resources/tools/win32', to: 'tools', filter: ['**/*'] }],
  },
  mac: {
    target: 'dmg',
    icon: 'assets/icon.png',
    identity: null,
    extraResources: [{ from: 'resources/tools/darwin', to: 'tools', filter: ['**/*'] }],
  },
  linux: {
    target: 'AppImage',
    icon: 'assets/icon.png',
    extraResources: [{ from: 'resources/tools/linux', to: 'tools', filter: ['**/*'] }],
  },
}

export default config
