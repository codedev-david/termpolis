// Electron main for the export-page specs' `electron` project: one plain window, as a person opening the exported
// page in an Electron shell would get. `electron electronHost.cjs <file>` opens that file; with no file the window
// starts on about:blank, so a spec can attach its request log, routes and init scripts first and then navigate.
// Software GL (SwiftShader), as in tests/e2e/fixtures/world-harness-main.cjs, so a runner with no GPU still gets WebGL.
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

const file = process.argv.slice(2).find((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.html'))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    backgroundColor: '#03050a',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  void (file ? win.loadFile(path.resolve(file)) : win.loadURL('about:blank'))
})

app.on('window-all-closed', () => app.quit())
