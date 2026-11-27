/**
 * The platform contract: everything the shared UI needs from its host shell.
 *
 * `app/` depends only on this file; each shell provides an implementation
 * (`electron.ts` today, a Capacitor one later). The domain types below are the
 * single source of truth — the Electron preload imports them from here
 * (`@hub/app/platform`) so `window.api` cannot drift from this contract.
 */

export type VpnStatus = 'disabled' | 'starting' | 'connected' | 'error'

export interface VpnInfo {
	status: VpnStatus
	port: number | null
	error: string | null
	endpoint: string | null
	/** the hubby the tunnel runs for (its config); older shells don't say */
	hubby?: string | null
}

export type UpdatePhase = 'available' | 'downloading' | 'verifying' | 'installing' | 'error'

export interface UpdateState {
	phase: UpdatePhase
	version: string
	currentVersion: string
	progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
	error: string | null
}

/** `devices`: the devices it is for ("desktop", "phone"); none: every one */
export interface IntegrationCookie { name: string; value: string; devices?: string[] }
export interface IntegrationReferer { url: string; cdnHostPattern: string }
export interface WebsiteIntegration {
	cookies?: IntegrationCookie[]
	referer?: IntegrationReferer
}

/** Unsubscribe handle returned by every `on…` listener. */
export type Unsubscribe = () => void

/**
 * A hubby as published or installed: its catalogue entry (app/scripts/build-hubbies.mjs), enough
 * to list it before it is installed.
 */
export interface HubbyPackage {
	id: string
	version: string
	/** the SDK range it needs (^x.y.z) */
	sdk: string
	css: boolean
	/** it ships models.json (its collections' models); absent in entries from before the flag */
	models?: boolean
	label: string
	description?: string
	/** its icon's [width, height, svg path] */
	icon?: [number, number, string] | null
	local?: boolean
	requires?: string[]
	requiresCapabilities?: string[]
}

/**
 * A restricted hubby (offered only to the accounts given it), as the server lists it for this
 * account: its catalogue entry (JSON, with its files) signed alone with the update key, and a
 * signed, expiring URL per file.
 */
export interface RestrictedHubbyPackage {
	entry: string
	/** base64 */
	signature: string
	urls: Record<string, string>
	/** an entry signed by its publisher's key, not the official one: that key's certificate */
	publisher?: PublisherCertificate
}

/**
 * A key allowed to sign one hubby's entries (a third party's): `certificate` is the JSON text
 * {"hubby": <id>, "key": <its Ed25519 public key, SPKI DER, base64>}, `signature` the official
 * key's (base64). Trusted for that hubby only.
 */
export interface PublisherCertificate {
	certificate: string
	signature: string
}

/** The hubbies of this device: installed from the server's catalogue (signed), on demand. */
export interface HubbyStoreApi {
	/**
	 * The hubbies this app can have, one entry each: the installed ones, and the published ones
	 * compatible with this app (the newest). Without the server (VPN down), the installed ones and
	 * the last catalogue read.
	 */
	list(): Promise<{ hubbies: HubbyPackage[]; installed: string[] }>
	/** Looks at the catalogue now (a version just published: the server said so): downloads what is newer; the versions ready ("id version"). */
	check?(): Promise<string[]>
	/** The user asked (the tray's Check for updates): the renderer applies every version ready, the open hubby's too. */
	onApplyRequested?(cb: () => void): Unsubscribe
	/** Installs a hubby (its newest compatible version), usable at once. Already installed: at once. */
	install(id: string): Promise<HubbyPackage>
	/** Removes a hubby's files from this device (a loaded one stays until the app restarts). */
	uninstall(id: string): Promise<void>
	/**
	 * The restricted hubbies this account was given (the server's list, renderer side: it needs the
	 * session): the store checks each signature, lists and installs them like the others.
	 */
	setRestricted(hubbies: RestrictedHubbyPackage[]): Promise<void>
	/**
	 * The newer versions already downloaded than what runs ("id version"). A hubby's version is
	 * decided at start; these wait for activate() (or the next start).
	 */
	pending(): Promise<string[]>
	/**
	 * Runs them from now on: all of them (the app reloads its page right after), or only these
	 * hubbies' (isolated ones: their frames reload, the app goes on). Returns what changed.
	 */
	activate(ids?: string[]): Promise<string[]>
}

/** One of the app's notifications, as the system shows it. */
/** How an AI model fits this device: as it should, only on the CPU (slower), not at all. */
export type ModelFit = 'runs' | 'slow' | 'cannot'

/** A variant of a model a hubby declares (hubby.json "ai"), against this device. */
export interface ModelVariantPlan { repo: string, revision: string, sizeBytes: number, fit: ModelFit, reason: string, installed: boolean }

/** A model a hubby declares, as this device sees it (client docs/plan-ia-moteur.md § 5). */
export interface ModelPlan {
	hubby: string
	hubbyLabel: string
	name: string
	family: 'text' | 'image' | 'voice' | 'embed'
	description: string | null
	variants: ModelVariantPlan[]
	/** the variant this device uses, null: none can run here */
	chosen: number | null
	consented: boolean
	installed: boolean
	download: { received: number, total: number } | null
	/** the declaration is refused (not pinned as it must be) */
	invalid: string | null
	/** added by the user from a link */
	byLink?: boolean
}

/** A model of a Hugging Face repo, as the device read it (a link the user gave). */
export interface RepoModel {
	name: string
	label: string
	files: Array<{ path: string, sha256: string, size: number }>
	sizeBytes: number
	requires: { vram: number, ram: number }
	fit: ModelFit
	reason: string
}

export interface RepoListing { repo: string, revision: string, models: RepoModel[], selected: string | null }

/** A model added by link, as a hubby keeps it (pinned when the repo was read). */
export interface UserModel { name: string, label: string, repo: string, revision: string, files: RepoModel['files'], requires: RepoModel['requires'] }

export interface InstalledModel { sha256: string, repo: string, revision: string, path: string, sizeBytes: number, users: string[] }

export interface LocalModelsState {
	device: { ramMib: number, gpu: { label: string, vramMib: number } | null, freeDiskMib: number, directory: string }
	plans: ModelPlan[]
	installed: InstalledModel[]
}

/** The AI models on this device: the ones the hubbies declare, downloaded once the user agreed. */
export interface LocalModelsApi {
	state(): Promise<LocalModelsState>
	/** the user agrees (this device): the model downloads (its progress: onChange) */
	download(hubby: string, name: string): Promise<void>
	remove(sha256: string): Promise<void>
	/** a Hugging Face repo's models, read by the device (a link the user gave) */
	inspect(link: string): Promise<RepoListing>
	/** the models added by link a hubby keeps (all of them) */
	setUserModels(hubby: string, list: UserModel[]): Promise<number>
	/** where new models go (a folder picker); null: cancelled */
	chooseDirectory(): Promise<string | null>
	onChange(cb: () => void): Unsubscribe
	onFailure(cb: (failure: { hubby: string, name: string, error: string }) => void): Unsubscribe
}

/** What a hubby asks a local model (`ai.chat`, client docs/plan-ia-moteur.md § 6). */
export interface AiChatRequest {
	model: string
	messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool', content: string, images?: string[], tool_calls?: unknown[], tool_call_id?: string }>
	tools?: Array<{ type: 'function', function: { name: string, description?: string, parameters?: Record<string, unknown> } }>
	temperature?: number
	maxTokens?: number
	reasoning?: boolean
	topP?: number
	minP?: number
	repeatPenalty?: number
	repeatLastN?: number
	presencePenalty?: number
	stop?: string[]
	template?: string
}

export interface AiChatResult {
	content: string
	toolCalls: Array<{ id: string, name: string, arguments: unknown, error?: string }>
	finishReason: string | null
	usage: { promptTokens: number, completionTokens: number, tokensPerSecond?: number } | null
}

/** consent / missing: the user has to allow / download the model first (the app asks, then calls again) */
export type AiChatOutcome =
	| { ok: true, result: AiChatResult }
	| { ok: false, code: 'consent' | 'missing' | 'unavailable' | 'invalid' | 'failed', message: string }

/** The local models, as the hubbies use them (main: ai/chat.ts). */
export interface LocalAiApi {
	chat(id: number, hubby: string, request: AiChatRequest): Promise<AiChatOutcome>
	abort(id: number): void
	onEvent(cb: (event: { id: number, kind: 'delta' | 'reasoning', text: string }) => void): Unsubscribe
	image(id: number, hubby: string, request: unknown): Promise<AiOutcome<AiImageResult>>
	speech(id: number, hubby: string, request: unknown): Promise<AiOutcome<AiSpeechResult>>
	/** a web surface's picture (`surfaceId`: its webview's WebContents id), and its vector by an image model (desktop) */
	snapshot?(hubby: string, surfaceId: number, request: unknown): Promise<AiOutcome<SurfaceSnapshot>>
	/** pictures' and a clip's stills' vectors by an image model (desktop: docs/plan-auto-desktop.md) */
	embedImages?(hubby: string, request: unknown): Promise<AiOutcome<{ vectors: Array<number[] | null>, errors: Array<string | null> }>>
	embedVideo?(hubby: string, request: unknown): Promise<AiOutcome<{ vectors: number[][], duration: number | null }>>
	/** the user picks a file for the hubby (null: cancelled) */
	importFile(hubby: string, kind: AiImportKind): Promise<AiImportedFile | null>
	/** the files a hubby imported (every one: null) */
	importedFiles(hubby: string | null): Promise<AiImportedFile[]>
	forgetFile(sha256: string): Promise<void>
}

/** A web surface's picture (SDK WebSurfaceElement.snapshot, docs/plan-discover-scan.md). */
export interface SurfaceSnapshot {
	/** data:image/jpeg URL */
	image: string
	/** the video's position (s), when a video was captured */
	time: number | null
	/** its vector (L2-normalised), when a model was asked */
	vector: number[] | null
}

export type AiImportKind = 'checkpoint' | 'lora' | 'audio'

/** A file imported for a hubby's AI (desktop main: ai/imports.ts). */
export interface AiImportedFile {
	sha256: string
	kind: AiImportKind
	name: string
	size: number
	family: 'sdxl' | 'sd1' | 'flux' | 'unknown' | null
	seconds: number | null
	users: string[]
}

export interface AiImageResult { image: string, width: number, height: number, seed: number | null, seconds: number }
export interface AiSpeechResult { audio: string, seconds: number }
export type AiOutcome<T> = { ok: true, result: T } | { ok: false, code: 'consent' | 'missing' | 'unavailable' | 'invalid' | 'refused' | 'failed', message: string }

/** A native web surface (Android: plugins/SurfacesPlugin.java), at a place in CSS pixels of the app's page. */
export interface NativeSurfacesApi {
	show(surface: { id: number, x: number, y: number, width: number, height: number, visible: boolean, src: string, referrer: string | null, userAgent: string | null }): Promise<void>
	close(id: number): Promise<void>
	exec(id: number, code: string): Promise<unknown>
	reload(id: number): Promise<void>
	back(id: number): Promise<void>
	forward(id: number): Promise<void>
	load(id: number, url: string): Promise<void>
	onEvent(cb: (event: { id: number, event: string, detail: Record<string, unknown> }) => void): Unsubscribe
}

/** A device agent's request, through Hubbyware's MCP server (main: ai/mcp.ts), for the app to answer (core/ai/agentBridge.ts). */
export interface AgentRequest {
	rid: number
	op: 'tools' | 'call'
	/** the hubby the agent works for (the AI hubby), its conversation */
	caller: string
	conversation: string
	name?: string
	input?: unknown
}

/** One of the device's AI agents, as a chat's engine (desktop main ai/agents.ts). */
export interface AgentEngine {
	id: string
	label: string
	kind: 'claude' | 'acp'
	available: boolean
	version: string | null
	signedIn: boolean | null
	note: string | null
}

export interface AgentRunRequest {
	engine: string
	/** the session of the account's device whose engine runs it (another one: relayed, core/ai/remote.ts); none: this one */
	device?: string | null
	conversation: string
	text: string
	transcript?: string | null
	instructions?: string | null
}

export interface AgentRunResult {
	content: string
	resumed: boolean
	usage: { inputTokens?: number, outputTokens?: number, costUsd?: number } | null
}

export interface AgentBridgeApi {
	onRequest(cb: (request: AgentRequest) => void): Unsubscribe
	respond(rid: number, result: unknown, error?: string): void
	engines(): Promise<AgentEngine[]>
	run(id: number, caller: string, request: AgentRunRequest): Promise<AgentRunResult>
	abort(id: number): void
	onEvent(cb: (event: { id: number, kind: 'delta' | 'status' | 'tool' | 'denied', text: string }) => void): Unsubscribe
}

export interface SystemNotification {
	id: number
	title: string
	body: string | null
	/** a state's count (null: an event); shown again when it grows */
	count: number | null
	/** where a click leads in the app */
	link: string | null
}

/**
 * The app's notifications shown by the system (desktop: its notification center, the dock marks
 * hub as having some). The page hands over its whole list at each change.
 */
export interface SystemNotificationsApi {
	sync(items: SystemNotification[]): void
	/** a click on one: the app opens its link */
	onOpen(cb: (link: string) => void): Unsubscribe
}

/** A document of a hubby's store (docs/plan-hubby-storage.md), local or on the server. */
export interface StoredDocument {
	collection: string
	id: string
	data: unknown
	/** milliseconds: the last write wins */
	updatedAt: number
}

/**
 * The device's base for the hubbies' data (SQLite: desktop in the main process, Android a plugin),
 * where the local-first sync keeps them (core/sync). Every call names the account (a hash), the
 * hubby and the scope.
 */
export interface LocalStoreApi {
	list(account: string, hubby: string, scope: string, collection?: string): Promise<StoredDocument[]>
	get(account: string, hubby: string, scope: string, collection: string, id: string): Promise<StoredDocument | null>
	put(account: string, hubby: string, scope: string, documents: StoredDocument[]): Promise<void>
	delete(account: string, hubby: string, scope: string, collection: string, id: string): Promise<void>
	purge(account: string, hubby: string, scope: string): Promise<void>
}

/**
 * The app's notifications by push (Android: Firebase Cloud Messaging): the server sends each change,
 * the shell shows it as a system notification, even with the app closed.
 */
/** A hubby's own icon on the phone's home screen (docs/plan-raccourcis.md), opening the app on it. */
export interface HomeShortcut {
	hubby: string
	label: string
	/** a PNG (base64, or a data: URL): the adaptive icon's full square */
	icon: string | null
}

export interface ShortcutsApi {
	/** whether the launcher takes pinned shortcuts */
	supported(): Promise<boolean>
	/** asks the launcher to add it (its own dialog); false: it was not shown */
	pin(shortcut: HomeShortcut): Promise<boolean>
	/** the shortcuts of hubbies no longer here greyed, the ones back (and up to date) enabled */
	sync(installed: HomeShortcut[]): Promise<void>
}

export interface PushApi {
	/** Asks the permission to notify (once) and returns this device's token for the server; null: no push. */
	register(): Promise<{ token: string; platform: 'android' } | null>
	/** a notification tapped: the app opens its link */
	onOpen(cb: (link: string) => void): Unsubscribe
}

/** What the web layer hands the native player: desktop VideoPlayerModal's webview inputs. */
export interface NativePlayerOptions {
	url: string
	/** Referer header for the first load (embed mode), null for none */
	referrer: string | null
	/** script run once the DOM is ready; the player is ready when its promise settles (null: ready on load) */
	bootstrap: string | null
	/** shown while the page loads */
	poster: string | null
	/** swipe neighbours: whether there is one each way, and its poster (slides in while swiping) */
	hasPrev: boolean
	hasNext: boolean
	prevPoster: string | null
	nextPoster: string | null
	/** posters to fetch ahead (videos further away), so fast swipes find them ready */
	preloadPosters: string[]
}

/** A Font Awesome icon as drawn natively: viewBox size + SVG path data. */
export interface NativeIcon {
	width: number
	height: number
	path: string
}

/** One of the player's actions, behind its gear button. Taps come back through `onAction`. */
export interface NativePlayerAction {
	id: string
	label: string
	icon: NativeIcon
	/** danger: a destructive action awaiting its confirming second tap */
	tone: 'default' | 'danger'
	/** running: shown dimmed, taps ignored */
	busy: boolean
}

/** Overlay over the video (tags, info); tapping it closes it. */
export interface NativePlayerPanel {
	chips?: string[]
	rows?: Array<[label: string, value: string]>
}

/**
 * Fullscreen native player above the app (Capacitor). Stands in for the
 * <webview> of the video player modal on shells without `capabilities.webview`;
 * only reached when `capabilities.nativePlayer` is true.
 */
export interface NativePlayerApi {
	open(options: NativePlayerOptions): Promise<void>
	exec(script: string): Promise<void>
	reload(): Promise<void>
	close(): Promise<void>
	/** the actions behind the gear (the whole list each time), and the icons of the gear and close buttons */
	setActions(actions: NativePlayerAction[], icons: { menu: NativeIcon; close: NativeIcon }): Promise<void>
	showPanel(panel: NativePlayerPanel | null): Promise<void>
	onReady(cb: () => void): Unsubscribe
	onClosed(cb: () => void): Unsubscribe
	onAction(cb: (id: string) => void): Unsubscribe
	/** a swipe went through: the web side switches to that neighbour and opens it */
	onNavigate(cb: (direction: 'prev' | 'next') => void): Unsubscribe
}

/**
 * What the host shell can do. The UI reads these to hide what a shell lacks
 * (e.g. the Capacitor shell has no native windows and no embedded browser).
 */
export interface PlatformCapabilities {
	/** integrated WireGuard tunnel controllable from the UI */
	vpn: boolean
	/**
	 * the tunnel carries only the webviews of the hubby using it (desktop: per session), the rest of
	 * the app going direct; false: it carries the whole app while it runs (Android: the WebView's
	 * proxy is the process's), so the hubby waits for it
	 */
	vpnPerWebview?: boolean
	/** hubbies hidden behind a reveal shortcut (Privacy) */
	privateMode: boolean
	/** in-app self-update */
	updates: boolean
	/** per-site cookie/referer injection for the embedded browser/player */
	integrations: boolean
	/** embedded <webview> (the integrated browser and the external player) */
	webview: boolean
	/** fullscreen native player (`platform.player`) instead of an embedded <webview> */
	nativePlayer: boolean
	/** separate native windows (Settings/History/About) vs in-app pages */
	nativeWindows: boolean
	/** global audio mute toggle */
	mute: boolean
	/** developer "local server" toggle */
	devMode: boolean
	/** AI models running on the device (`ai.chat`) */
	localAi: boolean
	/** a hubby's frame kept running unseen while the app runs (hubby.json `background`: docs/plan-auto-desktop.md D1) */
	background?: boolean
}

/**
 * The host shell, as seen by the shared UI. Method names mirror the Electron
 * preload so the Electron adapter is a thin pass-through; other shells
 * implement what they can and advertise the rest through `capabilities`.
 */
export interface Platform {
	readonly name: 'electron' | 'capacitor'
	/**
	 * Value sent in the `X-Hub-Client` header on the server's cookie-authenticated
	 * auth routes. Must be one of the server's accepted client values
	 * (SecurityController::CLIENT_HEADER_VALUES).
	 */
	readonly client: 'desktop' | 'android'
	readonly capabilities: PlatformCapabilities
	/** Host runtime info for the About screen (OS + engine versions). */
	readonly runtime: { os: string; versions: Record<string, string> }

	ping(): Promise<string>

	getDevMode(): Promise<boolean>
	onDevModeChange(cb: (value: boolean) => void): Unsubscribe

	notifyAuthState(authenticated: boolean): void

	/**
	 * The server just set a new refresh-token cookie (login, refresh: each
	 * refresh revokes the previous token). The shell makes it durable at once,
	 * or an app killed before its cookie store flushes comes back with a revoked
	 * token and a forced re-login.
	 */
	persistSession(): void

	/**
	 * The hidden hubbies revealed this session (Privacy: their shortcut), shared by the app's
	 * windows; forgotten at restart. Hidden again all at once by Ctrl+Alt+Q.
	 */
	getRevealedHubbies(): Promise<string[]>
	/**
	 * A secret kept by this device only, encrypted by the system (desktop: the OS keyring through
	 * safeStorage; Android: the Keystore): the account's data key (core/crypto). null: none.
	 */
	getDeviceSecret(name: string): Promise<string | null>
	/** null: forgotten. */
	setDeviceSecret(name: string, value: string | null): Promise<void>

	setRevealedHubbies(ids: string[]): void
	onRevealedHubbiesChange(cb: (ids: string[]) => void): Unsubscribe

	onWebviewKey(cb: (event: { key: string; ctrl: boolean; alt: boolean }) => void): Unsubscribe

	showMessage(message: string): Promise<void>

	/**
	 * The theme chosen (`mode`) and shown (`theme`, auto resolved), and the accent colour, for the
	 * shell: desktop, the native theme, the windows' background before they load and the icon in
	 * the accent; Android, the system bars.
	 */
	setTheme(mode: 'auto' | 'light' | 'dark', theme: 'light' | 'dark', accent: string): void

	getMuted(): Promise<boolean>
	setMuted(value: boolean): void
	onMutedChange(cb: (value: boolean) => void): Unsubscribe

	getVpnStatus(): Promise<VpnInfo>
	/** Starts the tunnel for a hubby, with its config (none named: the first hubby going out through the VPN). */
	startVpn(hubby?: string): Promise<void>
	stopVpn(): Promise<void>
	onVpnStatusChange(cb: (info: VpnInfo) => void): Unsubscribe
	/** Picks a WireGuard config file for a hubby (none named: the first going out through the VPN). */
	replaceVpnConfig(hubby?: string): Promise<{ ok: boolean; path: string | null; error?: string }>
	/**
	 * A hubby's VPN config, kept by the shell (server docs/plan-reseau-vpn.md): only whether there is
	 * one and its endpoint; the config itself never comes back to the web side.
	 */
	getVpnConfig(hubby: string): Promise<{ configured: boolean; endpoint: string | null }>
	/** Saves a hubby's WireGuard config (pasted); its tunnel, running, restarts with it. */
	setVpnConfig(hubby: string, text: string): Promise<{ ok: boolean; error?: string }>
	removeVpnConfig(hubby: string): Promise<void>

	/** Opens the Settings window, on a screen when given (e.g. 'security'). */
	openSettings(target?: string): Promise<void>
	/** In the Settings window: a screen another window asked for. */
	onSettingsGoto(cb: (target: string) => void): Unsubscribe
	/** Development (desktop): a hubby's files were built again (`hubby dev`): its frame reloads. */
	onHubbyFilesChange(cb: (hubby: string) => void): Unsubscribe
	openAbout(): Promise<void>

	getAppVersion(): Promise<string>
	getUpdateState(): Promise<UpdateState | null>
	onUpdateStateChange(cb: (state: UpdateState) => void): Unsubscribe
	installUpdate(): Promise<void>
	skipUpdate(): Promise<void>
	quitApp(): Promise<void>

	listIntegrations(): Promise<Array<{ host: string; updatedAt: number }>>
	applyIntegration(payload: { host: string; integration: WebsiteIntegration; updatedAt: number }): Promise<void>
	removeIntegration(host: string): Promise<void>

	/**
	 * Hosts the embedded browser / video player blocks (ads, trackers), compiled
	 * by the back. The shell persists the list; the version lets the UI skip a
	 * download when it already holds the latest one.
	 */
	getPlayerBlocklistVersion(): Promise<string | null>
	setPlayerBlocklist(version: string, hosts: string[]): Promise<void>

	readonly player: NativePlayerApi
	/** null: the shell shows none (Android: they come by push, `push`) */
	readonly systemNotifications: SystemNotificationsApi | null
	/** null: no push (desktop: the open app shows them itself) */
	readonly push: PushApi | null
	/** null: no home screen shortcuts (desktop, for now) */
	readonly shortcuts: ShortcutsApi | null
	/** null: no local store here (Android, for now): a scope kept local isn't reachable on this device */
	readonly localStore: LocalStoreApi | null
	/** null: the hubbies come from their sources (development), all of them, nothing to install */
	readonly hubbyStore: HubbyStoreApi | null
	/** null: no local AI models here (Android, for now) */
	readonly localModels: LocalModelsApi | null
	/** null: no local AI here (Android, for now) */
	readonly localAi: LocalAiApi | null
	/**
	 * A hubby's web surfaces as native views (Android: a WebView over the app's at the frame's place);
	 * null: the shell shows them as <webview> elements (desktop) or not at all.
	 */
	readonly nativeSurfaces: NativeSurfacesApi | null
	/** null: no device agents here (they are desktop programs) */
	readonly agentBridge: AgentBridgeApi | null
	/**
	 * Where an isolated hubby's frame loads from (its own origin: desktop hubby://<id>/, Android
	 * https://<id>.hubby.localhost/); null where hubbies can't run isolated (yet).
	 */
	hubbyUrl(hubby: string): string | null
}
