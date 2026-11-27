import type { Api } from '@preload'
import type { NativePlayerApi, Platform, PlatformCapabilities } from './types'

// This is the ONE file in app/ allowed to know about the Electron preload: the
// Electron adapter legitimately couples to the Electron shell. Everything else
// imports from '@platform'. The method names of `window.api` mirror the Platform
// contract, so the adapter is a thin pass-through (spread), and `window.api`
// importing the domain types from here keeps the two in lockstep.
declare global {
	interface Window {
		api: Api
	}
}

const capabilities: PlatformCapabilities = {
	localAi: true,
	background: true,
	vpn: true,
	vpnPerWebview: true,
	privateMode: true,
	updates: true,
	integrations: true,
	webview: true,
	nativePlayer: false,
	nativeWindows: true,
	mute: true,
	devMode: true
}

// The player is an embedded <webview> on desktop (capabilities.nativePlayer is
// false), so this is never reached; it throws to catch a missing check.
const player: NativePlayerApi = new Proxy({} as NativePlayerApi, {
	get(_t, prop) {
		return () => { throw new Error(`[platform:electron] player.${String(prop)} is not available on desktop`) }
	}
})

export function createElectronPlatform(): Platform {
	const runtime = {
		os: window.api.platform,
		versions: window.api.versions as unknown as Record<string, string>
	}
	// persistSession: the main process already writes the refresh cookie as soon as it changes.
	// hubbyStore: in development the hubbies come from their sources (core/hubby/registry)
	return {
		name: 'electron', client: 'desktop', capabilities, runtime, player, persistSession: () => {},
		...window.api,
		push: null,
		shortcuts: null,
		hubbyStore: import.meta.env.DEV ? null : window.api.hubbyStore,
		localModels: window.api.localModels,
		localAi: window.api.localAi,
		nativeSurfaces: null,
		agentBridge: window.api.agentBridge,
		// served by the main process (its hubby:// protocol)
		hubbyUrl: hubby => `hubby://${hubby}/`
	}
}

export default createElectronPlatform
