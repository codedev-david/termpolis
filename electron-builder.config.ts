import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.termpolis.app',
  productName: 'Termpolis',
  directories: { output: 'dist-electron-builder' },
  files: ['dist/**/*', 'dist-electron/**/*'],
  win: { target: 'nsis', icon: 'assets/icon.ico' },
  mac: { target: 'dmg', icon: 'assets/icon.icns' },
  linux: { target: 'AppImage', icon: 'assets/icon.png' },
}

export default config
