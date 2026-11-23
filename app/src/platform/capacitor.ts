import { registerPlugin } from '@capacitor/core'
import { createLocalAi, createLocalModels } from './capacitorLocalAi'
import { createNativeSurfaces } from './capacitorSurfaces'
import type { NativeIcon, NativePlayerAction, NativePlayerApi, NativePlayerOptions, NativePlayerPanel, Platform, PushApi, PlatformCapabilities, Unsubscribe, VpnInfo, WebsiteIntegration } from './types'
import { checkHubbyUpdates, createHubbyStore, startHubbyUpdates } from './capacitorHubbies'
import { createUpdater } from './capacitorUpdater'
import { createLocalStore } from './capacitorLocalStore'

// Capacitor (Android) adapter. The mobile shell is a second client of the
// server hubbies; the desktop-only surfaces (local AI, embedded browser,
// native windows) are absent and advertised as such through `capabilities`, so
// the UI hides them and never calls into them. The VPN (embedded WireGuard
// tunnel), the video player (fullscreen native WebView) and the website
// integrations (cookies, CDN referer) are native plugins of the shell
// (mobile/android: VpnPlugin, PlayerPlugin, IntegrationsPlugin).

const capabilities: PlatformCapabilities = {
	// the phone's own models (text, voice: client docs/plan-ia-android.md); a hubby asks which of its
	// models run here (ai.models.available)
	localAi: !import.meta.env.DEV,
	vpn: true,
	vpnPerWebview: false,
	privateMode: true,
	updates: true,
	integrations: true,
	// web surfaces: native WebViews over the app's (Surfaces plugin), not <webview> elements
	webview: !import.meta.env.DEV,
	nativePlayer: true,
	nativeWindows: false,
	mute: false,
	devMode: false
}

const noop = (): void => {}
/** A listener for an event this shell never emits: nothing to unsubscribe. */
const noSubscription = (): Unsubscribe => noop

function unavailable(feature: string): never {
	throw new Error(`[platform:capacitor] ${feature} is not available on mobile`)
}

interface PluginListener { remove(): Promise<void> }

interface VpnPlugin {
	getStatus(): Promise<VpnInfo>
	start(options: { hubby?: string }): Promise<void>
	stop(): Promise<void>
	replaceConfig(options: { hubby?: string }): Promise<{ ok: boolean; path: string | null; error?: string }>
	getConfig(options: { hubby: string }): Promise<{ configured: boolean; endpoint: string | null }>
	setConfig(options: { hubby: string; text: string }): Promise<{ ok: boolean; error?: string }>
	removeConfig(options: { hubby: string }): Promise<void>
	addListener(event: 'statusChange', cb: (info: VpnInfo) => void): Promise<PluginListener>
}

interface PlayerPlugin {
	open(options: NativePlayerOptions): Promise<void>
	exec(options: { script: string }): Promise<void>
	reload(): Promise<void>
	close(): Promise<void>
	setActions(options: { actions: NativePlayerAction[]; icons: { menu: NativeIcon; close: NativeIcon } }): Promise<void>
	showPanel(options: { panel: NativePlayerPanel | null }): Promise<void>
	addListener(event: 'ready' | 'closed', cb: () => void): Promise<PluginListener>
	addListener(event: 'action', cb: (data: { id: string }) => void): Promise<PluginListener>
	addListener(event: 'navigate', cb: (data: { direction: 'prev' | 'next' }) => void): Promise<PluginListener>
	getBlocklistVersion(): Promise<{ version: string | null }>
	setBlocklist(options: { version: string; hosts: string[] }): Promise<void>
}

interface SessionPlugin {
	flush(): Promise<void>
}

interface DeviceSecretsPlugin {
	get(options: { name: string }): Promise<{ value: string | null }>
	set(options: { name: string; value: string | null }): Promise<void>
}

interface PushPlugin {
	register(): Promise<{ token: string }>
	addListener(event: 'open', cb: (data: { link: string }) => void): Promise<PluginListener>
}

interface IntegrationsPlugin {
	list(): Promise<{ entries: Array<{ host: string; updatedAt: number }> }>
	apply(options: { host: string; integration: WebsiteIntegration; updatedAt: number }): Promise<void>
	remove(options: { host: string }): Promise<void>
}

const Vpn = registerPlugin<VpnPlugin>('Vpn')
const Integrations = registerPlugin<IntegrationsPlugin>('Integrations')
const Player = registerPlugin<PlayerPlugin>('Player')
const Session = registerPlugin<SessionPlugin>('Session')
const DeviceSecrets = registerPlugin<DeviceSecretsPlugin>('DeviceSecrets')
const Push = registerPlugin<PushPlugin>('Push')
const Theme = registerPlugin<{ set(options: { theme: 'light' | 'dark'; accent: string }): Promise<void> }>('Theme')

/** Plugin listeners register asynchronously; the contract's unsubscribe is sync. */
function subscribe(listener: Promise<PluginListener>): Unsubscribe {
	return () => { void listener.then(l => l.remove()) }
}

const push: PushApi = {
	register: async () => {
		try {
			return { token: (await Push.register()).token, platform: 'android' }
		}
		catch (err) {
			console.warn('[push] no token', err)
			return null
		}
	},
	onOpen: cb => subscribe(Push.addListener('open', ({ link }) => cb(link)))
}

const player: NativePlayerApi = {
	open: options => Player.open(options),
	exec: script => Player.exec({ script }),
	reload: () => Player.reload(),
	close: () => Player.close(),
	setActions: (actions, icons) => Player.setActions({ actions, icons }),
	showPanel: panel => Player.showPanel({ panel }),
	onReady: cb => subscribe(Player.addListener('ready', cb)),
	onClosed: cb => subscribe(Player.addListener('closed', cb)),
	onAction: cb => subscribe(Player.addListener('action', ({ id }) => cb(id))),
	onNavigate: cb => subscribe(Player.addListener('navigate', ({ direction }) => cb(direction)))
}

/**
 * The hidden hubbies revealed this session live in memory, like desktop's main-process list: forgotten
 * when the app restarts. No keyboard on a phone: the /reveal command reveals.
 */
function createRevealed() {
	let value: string[] = []
	const listeners = new Set<(ids: string[]) => void>()
	return {
		get value() { return value },
		set(next: string[]): void {
			const ids = [...new Set(next)].sort()
			if (ids.join() === value.join()) return
			value = ids
			for (const cb of listeners) cb(value)
		},
		subscribe(cb: (ids: string[]) => void): Unsubscribe {
			listeners.add(cb)
			return () => { listeners.delete(cb) }
		}
	}
}

export function createCapacitorPlatform(): Platform {
	const revealed = createRevealed()
	const updater = createUpdater()
	startHubbyUpdates()
	// /releases/ is public (signed): checked at once, the periodic check covers the rest
	void updater.check()
	void checkHubbyUpdates()

	return {
		name: 'capacitor',
		client: 'android',
		capabilities,
		runtime: { os: 'android', versions: {} },

		ping: () => Promise.resolve('pong'),

		getDevMode: () => Promise.resolve(false),
		onDevModeChange: noSubscription,

		// The renderer notifies the shell of auth transitions (desktop uses it to
		// drive the tray/VPN). The mobile shell has nothing to do with it yet.
		notifyAuthState: noop,
		persistSession: () => { void Session.flush() },

		getRevealedHubbies: () => Promise.resolve(revealed.value),
		setRevealedHubbies: ids => revealed.set(ids),
		onRevealedHubbiesChange: cb => revealed.subscribe(cb),

		getDeviceSecret: name => DeviceSecrets.get({ name }).then(r => r.value ?? null),
		setDeviceSecret: (name, value) => DeviceSecrets.set({ name, value }),

		onWebviewKey: noSubscription,

		showMessage: () => Promise.resolve(),

		getMuted: () => Promise.resolve(false),
		setMuted: noop,
		onMutedChange: noSubscription,

		getVpnStatus: () => Vpn.getStatus(),
		startVpn: hubby => Vpn.start({ hubby }),
		stopVpn: () => Vpn.stop(),
		onVpnStatusChange: cb => subscribe(Vpn.addListener('statusChange', cb)),
		replaceVpnConfig: hubby => Vpn.replaceConfig({ hubby }),
		getVpnConfig: hubby => Vpn.getConfig({ hubby }),
		setVpnConfig: (hubby, text) => Vpn.setConfig({ hubby, text }),
		removeVpnConfig: hubby => Vpn.removeConfig({ hubby }),

		// no Settings window here: a page of the app
		setTheme: (_mode, theme, accent) => { void Theme.set({ theme, accent }).catch(() => {}) },
		openSettings: async target => { window.location.hash = `#/settings${target ? `/${target}` : ''}` },
		onSettingsGoto: () => () => {},
		onHubbyFilesChange: () => () => {},
		systemNotifications: null,
		push,
		localStore: createLocalStore(),
		hubbyStore: import.meta.env.DEV ? null : createHubbyStore(),
		// the phone's own models (text, voice: client docs/plan-ia-android.md)
		localModels: import.meta.env.DEV ? null : createLocalModels(),
		localAi: import.meta.env.DEV ? null : createLocalAi(),
		nativeSurfaces: import.meta.env.DEV ? null : createNativeSurfaces(),
		agentBridge: null,
		// served by the WebView (HubbyStore intercepts these hosts)
		hubbyUrl: hubby => `https://${hubby}.hubby.localhost/`,
		openAbout: () => unavailable('openAbout'),

		getAppVersion: () => updater.getCurrentVersion(),
		getUpdateState: () => Promise.resolve(updater.getState()),
		onUpdateStateChange: cb => updater.subscribe(cb),
		installUpdate: () => updater.install(),
		skipUpdate: () => { updater.skip(); return Promise.resolve() },
		// No app process to quit on Android; the OS owns the lifecycle.
		quitApp: () => Promise.resolve(),

		// Cookies into Android's CookieManager (the CDN referer rule isn't applied on mobile).
		listIntegrations: () => Integrations.list().then(r => r.entries),
		applyIntegration: payload => Integrations.apply(payload),
		removeIntegration: host => Integrations.remove({ host }),

		getPlayerBlocklistVersion: () => Player.getBlocklistVersion().then(r => r.version),
		setPlayerBlocklist: (version, hosts) => Player.setBlocklist({ version, hosts }),

		player
	}
}

export default createCapacitorPlatform
