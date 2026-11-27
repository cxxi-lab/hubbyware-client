import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
	VpnInfo,
	UpdateState,
	WebsiteIntegration,
	HubbyPackage,
	RestrictedHubbyPackage,
	StoredDocument,
	SystemNotification
} from '@hub/app/platform'

/** An IPC call whose error reads as the main process wrote it (not "Error invoking remote method 'x': Error: …"). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as ipcRenderer.invoke: the renderer types each call
function invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
	return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
		throw new Error(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
	})
}

const api = {

	platform: process.platform,
	versions: process.versions,

	ping: (): Promise<string> => ipcRenderer.invoke('ping'),

	getDevMode: (): Promise<boolean> => ipcRenderer.invoke('dev-mode:get'),

	onDevModeChange: (cb: (value: boolean) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, value: boolean) => cb(value)
		ipcRenderer.on('dev-mode:changed', handler)
		return () => ipcRenderer.removeListener('dev-mode:changed', handler)
	},

	notifyAuthState: (authenticated: boolean): void => {
		ipcRenderer.send('auth:state-changed', authenticated)
	},

	getRevealedHubbies: (): Promise<string[]> => ipcRenderer.invoke('revealed-hubbies:get'),

	getDeviceSecret: (name: string): Promise<string | null> => ipcRenderer.invoke('device-secret:get', name),
	setDeviceSecret: (name: string, value: string | null): Promise<void> => ipcRenderer.invoke('device-secret:set', name, value),

	setRevealedHubbies: (ids: string[]): void => {
		ipcRenderer.send('revealed-hubbies:set', ids)
	},

	onRevealedHubbiesChange: (cb: (ids: string[]) => void): (() => void) => subscribe<string[]>('revealed-hubbies:changed', cb),

	onWebviewKey: (cb: (event: { key: string; ctrl: boolean; alt: boolean }) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, payload: { key: string; ctrl: boolean; alt: boolean }) => cb(payload)
		ipcRenderer.on('webview-key', handler)
		return () => ipcRenderer.removeListener('webview-key', handler)
	},

	showMessage: (message: string): Promise<void> => ipcRenderer.invoke('dialog:message', message),

	getMuted: (): Promise<boolean> => ipcRenderer.invoke('audio:muted:get'),

	setMuted: (value: boolean): void => {
		ipcRenderer.send('audio:muted:set', value)
	},
	
	onMutedChange: (cb: (value: boolean) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, value: boolean) => cb(value)
		ipcRenderer.on('audio:muted:changed', handler)
		return () => ipcRenderer.removeListener('audio:muted:changed', handler)
	},

	getVpnStatus: (): Promise<VpnInfo> => ipcRenderer.invoke('vpn:status:get'),

	startVpn: (hubby?: string): Promise<void> => ipcRenderer.invoke('vpn:start', hubby),

	stopVpn: (): Promise<void> => ipcRenderer.invoke('vpn:stop'),

	onVpnStatusChange: (cb: (info: VpnInfo) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, info: VpnInfo) => cb(info)
		ipcRenderer.on('vpn:status:changed', handler)
		return () => ipcRenderer.removeListener('vpn:status:changed', handler)
	},

	openSettings: (target?: string): Promise<void> => ipcRenderer.invoke('settings:open', target),

	setTheme: (mode: 'auto' | 'light' | 'dark', theme: 'light' | 'dark', accent: string): void => {
		ipcRenderer.send('theme:set', mode, theme, accent)
	},

	/** In the Settings window: a screen another window asked for (see openSettings). */
	onHubbyFilesChange: (cb: (hubby: string) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, hubby: string) => cb(hubby)
		ipcRenderer.on('hubbies:dev-changed', handler)
		return () => ipcRenderer.removeListener('hubbies:dev-changed', handler)
	},
	onSettingsGoto: (cb: (target: string) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, target: string) => cb(target)
		ipcRenderer.on('settings:goto', handler)
		return () => ipcRenderer.removeListener('settings:goto', handler)
	},

	/** Opens an OAuth consent page; resolves with the redirect URL it ended on (null: closed). */



	localStore: {
		list: (account: string, hubby: string, scope: string, collection?: string): Promise<StoredDocument[]> => ipcRenderer.invoke('store:list', account, hubby, scope, collection),
		get: (account: string, hubby: string, scope: string, collection: string, id: string): Promise<StoredDocument | null> => ipcRenderer.invoke('store:get', account, hubby, scope, collection, id),
		put: (account: string, hubby: string, scope: string, documents: StoredDocument[]): Promise<void> => ipcRenderer.invoke('store:put', account, hubby, scope, documents),
		delete: (account: string, hubby: string, scope: string, collection: string, id: string): Promise<void> => ipcRenderer.invoke('store:delete', account, hubby, scope, collection, id),
		purge: (account: string, hubby: string, scope: string): Promise<void> => ipcRenderer.invoke('store:purge', account, hubby, scope)
	},

	// the AI models on this device (main: ai/models.ts); their errors as the main process wrote them
	localModels: {
		state: () => invoke('ai-models:state'),
		download: (hubby: string, name: string): Promise<void> => invoke('ai-models:download', hubby, name),
		remove: (sha256: string): Promise<void> => invoke('ai-models:remove', sha256),
		inspect: (link: string) => invoke('ai-models:inspect', link),
		setUserModels: (hubby: string, list: unknown): Promise<number> => invoke('ai-models:set-user', hubby, list),
		chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('ai-models:directory'),
		onChange: (cb: () => void): (() => void) => subscribe<void>('ai-models:changed', () => cb()),
		onFailure: (cb: (failure: { hubby: string, name: string, error: string }) => void): (() => void) => subscribe('ai-models:failed', cb)
	},

	// ai.chat (main: ai/chat.ts): its answer streams as ai:chat:event
	localAi: {
		chat: (id: number, hubby: string, request: unknown) => ipcRenderer.invoke('ai:chat', id, hubby, request),
		abort: (id: number): void => { ipcRenderer.send('ai:chat:abort', id) },
		onEvent: (cb: (event: { id: number, kind: 'delta' | 'reasoning', text: string }) => void): (() => void) => subscribe('ai:chat:event', cb),
		// ai.image, ai.speech (main: ai/image.ts, ai/speech.ts); abort() stops them too
		image: (id: number, hubby: string, request: unknown) => ipcRenderer.invoke('ai:image', id, hubby, request),
		speech: (id: number, hubby: string, request: unknown) => ipcRenderer.invoke('ai:speech', id, hubby, request),
		// a web surface's picture and its vector (main: ai/snapshot.ts)
		snapshot: (hubby: string, surfaceId: number, request: unknown) => ipcRenderer.invoke('ai:snapshot', hubby, surfaceId, request),
		// pictures and clips' vectors (main: ai/media.ts)
		embedImages: (hubby: string, request: unknown) => ipcRenderer.invoke('ai:embed-images', hubby, request),
		embedVideo: (hubby: string, request: unknown) => ipcRenderer.invoke('ai:embed-video', hubby, request),
		// files imported for a hubby (main: ai/imports.ts)
		importFile: (hubby: string, kind: 'checkpoint' | 'lora' | 'audio') => invoke('ai-files:add', hubby, kind),
		importedFiles: (hubby: string | null) => invoke('ai-files:list', hubby),
		forgetFile: (sha256: string): Promise<void> => invoke('ai-files:forget', sha256)
	},

	// a device agent's requests through Hubbyware's MCP server (main ai/mcp.ts), answered by the app
	agentBridge: {
		onRequest: (cb: (request: { rid: number, op: 'tools' | 'call', caller: string, conversation: string, name?: string, input?: unknown }) => void): (() => void) => subscribe('agent:request', cb),
		respond: (rid: number, result: unknown, error?: string): void => { ipcRenderer.send('agent:response', rid, result, error) },
		// the device's agents as the chat's engines (main ai/agents.ts)
		engines: () => invoke('agent:engines'),
		run: (id: number, caller: string, request: unknown) => invoke('agent:run', id, caller, request),
		abort: (id: number): void => { ipcRenderer.send('agent:abort', id) },
		onEvent: (cb: (event: { id: number, kind: 'delta' | 'status' | 'tool' | 'denied', text: string }) => void): (() => void) => subscribe('agent:event', cb)
	},

	systemNotifications: {
		sync: (items: SystemNotification[]): void => {
			ipcRenderer.send('system-notifications:sync', items)
		},
		onOpen: (cb: (link: string) => void): (() => void) => subscribe<string>('system-notifications:open', cb)
	},

	hubbyStore: {
		list: (): Promise<{ hubbies: HubbyPackage[]; installed: string[] }> => ipcRenderer.invoke('hubbies:list'),
		install: (id: string): Promise<HubbyPackage> => ipcRenderer.invoke('hubbies:install', id),
		uninstall: (id: string): Promise<void> => ipcRenderer.invoke('hubbies:uninstall', id),
		setRestricted: (hubbies: RestrictedHubbyPackage[]): Promise<void> => ipcRenderer.invoke('hubbies:restricted', hubbies),
		pending: (): Promise<string[]> => ipcRenderer.invoke('hubbies:pending'),
		activate: (ids?: string[]): Promise<string[]> => ipcRenderer.invoke('hubbies:activate', ids),
		check: (): Promise<string[]> => ipcRenderer.invoke('hubbies:check'),
		onApplyRequested: (cb: () => void): (() => void) => subscribe<void>('hubbies:apply', () => cb())
	},

	openAbout: (): Promise<void> => ipcRenderer.invoke('about:open'),

	getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

	getUpdateState: (): Promise<UpdateState | null> => ipcRenderer.invoke('update:state:get'),

	onUpdateStateChange: (cb: (state: UpdateState) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, state: UpdateState) => cb(state)
		ipcRenderer.on('update:state:changed', handler)
		return () => ipcRenderer.removeListener('update:state:changed', handler)
	},

	installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),

	skipUpdate: (): Promise<void> => ipcRenderer.invoke('update:skip'),

	quitApp: (): Promise<void> => ipcRenderer.invoke('update:quit'),

	replaceVpnConfig: (hubby?: string): Promise<{ ok: boolean; path: string | null; error?: string }> =>
		ipcRenderer.invoke('vpn:config:replace', hubby),
	getVpnConfig: (hubby: string): Promise<{ configured: boolean; endpoint: string | null }> =>
		ipcRenderer.invoke('vpn:config:get', hubby),
	setVpnConfig: (hubby: string, text: string): Promise<{ ok: boolean; error?: string }> =>
		ipcRenderer.invoke('vpn:config:set', hubby, text),
	removeVpnConfig: (hubby: string): Promise<void> => ipcRenderer.invoke('vpn:config:remove', hubby),

	listIntegrations: (): Promise<Array<{ host: string; updatedAt: number }>> =>
		ipcRenderer.invoke('integrations:list'),

	applyIntegration: (payload: { host: string; integration: WebsiteIntegration; updatedAt: number }): Promise<void> =>
		ipcRenderer.invoke('integrations:apply', payload),

	removeIntegration: (host: string): Promise<void> =>
		ipcRenderer.invoke('integrations:remove', host),

	getPlayerBlocklistVersion: (): Promise<string | null> => ipcRenderer.invoke('player-blocklist:version'),

	setPlayerBlocklist: (version: string, hosts: string[]): Promise<void> =>
		ipcRenderer.invoke('player-blocklist:set', { version, hosts })
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
	const handler = (_: IpcRendererEvent, payload: T) => cb(payload)
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
