import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.termpolis.app',
  productName: 'Termpolis',
  directories: { output: 'dist-electron-builder' },
  files: ['out/**/*'],
  win: { target: 'nsis', icon: 'assets/icon.ico' },
  mac: { target: 'dmg', icon: 'assets/icon.png', identity: null },
  linux: { target: 'AppImage', icon: 'assets/icon.png' },
}

export default config
