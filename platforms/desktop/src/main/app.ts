// first: the app's name and data folder, before any hubby reads them
import { APP_NAME } from './app/identity'
export { APP_NAME }
import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import { setupLocalAi } from './ai'
import { setupAgents } from './ai/agents'
import { applyMenu } from './app/menu'
import { acquireSingleInstanceLock, RELAUNCH_FLAG } from './app/restart'
import { installSecurityHandlers } from './app/security'
import './app/schemes'
import './app/state'
import './app/deviceSecrets'
import { setupPlayerBlocklist } from './session/playerBlocklist'
import { dropBrowseSession } from './session/dropBrowse'
import { integrationsRegistry } from './session/integrations'
import { persistRefreshCookie } from './session/sessions'
import { checkForUpdateAtStartup } from './network/updater'
import { setupHubbies } from './hubbies/manager'
import { setupVpn } from './network/vpn'
import { setupTray } from './app/tray'
import { setupSystemNotifications } from './app/notifications'
import { setupLocalStore } from './store/localStore'
import { setupTheme } from './app/theme'
import { createWindow, showMainWindow } from './windows/main'
import './windows/settings'
import './windows/about'
import { installWebviewHandlers } from './windows/webview'

// its windows titled Hubbyware (dev) in development
if (!app.isPackaged) {
	app.on('browser-window-created', (_event, window) => {
		const title = (page: string) => page === '' || page === 'Hubbyware' ? 'Hubbyware (dev)' : `${page} · Hubbyware (dev)`
		window.setTitle(title(window.getTitle()))
		window.on('page-title-updated', (event, page) => {
			event.preventDefault()
			window.setTitle(title(page))
		})
	})
}

// Force WebRTC to only use the proxied transport, blocking direct UDP that
// would otherwise leak the real IP via STUN. Must be set before app ready.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')

// Dev only: Chrome DevTools Protocol on loopback, so tooling can drive and
// inspect the UI (touch emulation, screenshots, console).
if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', process.env.HUB_DEVTOOLS_PORT ?? '9222')

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('dialog:message', async (event, message: string) => {
	const win = BrowserWindow.fromWebContents(event.sender)
	if (!win) return
	await dialog.showMessageBox(win, {
		type: 'info',
		message,
		buttons: ['OK']
	})
})

// One hub at a time: launching it again brings the running one back from the tray.
const singleInstance = acquireSingleInstanceLock()
void singleInstance.then(locked => { if (!locked) app.exit(0) })
// A relaunched instance knocks while this one quits: nothing to show then.
app.on('second-instance', (_, argv) => { if (!argv.includes(RELAUNCH_FLAG)) showMainWindow() })

installSecurityHandlers()
installWebviewHandlers()

app.whenReady().then(async () => {
	if (!(await singleInstance)) return
	dropBrowseSession()
	// before any window: they open in the theme's colours
	setupTheme()
	persistRefreshCookie()
	setupPlayerBlocklist()
	setupVpn()
	setupLocalAi()
	setupAgents()
	applyMenu()
	setupTray()
	setupSystemNotifications()
	setupLocalStore()

	await integrationsRegistry.applyAll()

	// A pending update is installed before the app can be used: only the update window opens.
	if (app.isPackaged && await checkForUpdateAtStartup()) return

	// the hubby versions of this session; newer ones download in the background for the next start
	setupHubbies()
	createWindow()

	app.on('activate', () => showMainWindow())
})

// The main window hides instead of closing: hub keeps running in the tray until quit from there.
app.on('window-all-closed', () => {})
