import { useEffect, useState } from 'react'
import { onBackDepth, handleBack } from '@cxxi-lab/hubbyware-ui'
import { PROTOCOL, type AppState, type CallError, type Envelope, type GuestMessage, type HostMessage, type HubbyPage, type TaskState } from '../protocol'

/**
 * The hubby SDK inside its frame (prototype): every call goes to the host by message and comes
 * back as a promise. The frame has no token, no cookie, no access to the app.
 */

/**
 * Non-2xx response (as in the app: `message` stays `HTTP <status>`, `detail` carries the server's
 * explanation when there is one).
 */
export class ApiError extends Error {
	readonly status: number
	readonly detail: string | null
	constructor(status: number, detail: string | null) {
		super(`HTTP ${status}`)
		this.name = 'ApiError'
		this.status = status
		this.detail = detail
	}
}

/** Best human-readable message for a caught error: server detail first. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
	if (err instanceof ApiError) return err.detail ?? err.message
	if (err instanceof Error) return err.message || fallback
	return fallback
}

function failureOf(error: string, failure?: CallError): Error {
	if (failure?.status !== undefined) return new ApiError(failure.status, failure.detail ?? null)
	return new Error(failure?.message ?? error)
}

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>()
const stateListeners = new Set<(state: AppState) => void>()
const streamListeners = new Map<number, (event: string, data: unknown) => void>()
const changeListeners = new Map<string, Set<(id: string) => void>>()
let appState: AppState = { phone: false, privateMode: false, visible: true, amountsBlurred: false, blurEpoch: 0, tunnelReady: true }
const initListeners = new Set<(init: Extract<HostMessage, { type: 'init' }>) => void>()
const pathListeners = new Set<(path: string) => void>()
const taskListeners = new Map<string, Set<(state: TaskState) => void>>()
let init: Extract<HostMessage, { type: 'init' }> | null = null

/** The host's first word (the frame's context), once it came. */
export function whenInit(): Promise<Extract<HostMessage, { type: 'init' }>> {
	if (init) return Promise.resolve(init)
	return new Promise(resolve => {
		const once = (m: Extract<HostMessage, { type: 'init' }>) => { initListeners.delete(once); resolve(m) }
		initListeners.add(once)
	})
}

function post(message: GuestMessage) {
	const envelope: Envelope<GuestMessage> = { protocol: PROTOCOL, message }
	// the host's origin can't be checked from an opaque origin: '*', the host checks the source
	window.parent.postMessage(envelope, '*')
}

/** The app's theme and accent on this frame's root (the shared tokens are redefined under them). */
function applyTheme(theme: 'light' | 'dark' | undefined, accent: string | undefined) {
	const root = document.documentElement
	const value = theme ?? 'dark'
	root.dataset.theme = value
	root.style.colorScheme = value
	if (accent && accent !== 'blue') root.dataset.accent = accent
	else delete root.dataset.accent
}

const hostListeners = new Set<(m: HostMessage) => void>()
const reselectListeners = new Set<(path: string) => void>()

/**
 * A page of its navigation tapped while already on it (a phone's bottom bar, as Android's apps
 * do: back to the top, or the page's own action, e.g. Shuffle again). `path`: the page's, absolute
 * (`/<hubby>/…`).
 */
export function useNavReselect(path: string, onReselect: () => void): void {
	useEffect(() => {
		const listener = (p: string) => { if (p === path) onReselect() }
		reselectListeners.add(listener)
		return () => { reselectListeners.delete(listener) }
	}, [path, onReselect])
}

/** Called with each message of the host (the frame's other parts: the player, the surfaces). */
export function onHostMessage(listener: (m: HostMessage) => void): () => void {
	hostListeners.add(listener)
	return () => { hostListeners.delete(listener) }
}

window.addEventListener('message', event => {
	if (event.source !== window.parent) return
	const data = event.data as Envelope<HostMessage> | undefined
	if (data?.protocol !== PROTOCOL) return
	const m = data.message
	hostListeners.forEach(l => l(m))
	if (m.type === 'result') {
		const p = pending.get(m.id)
		pending.delete(m.id)
		if (!p) return
		if (m.ok) p.resolve(m.value)
		else p.reject(failureOf(m.error, m.failure))
	}
	else if (m.type === 'init') {
		applyTheme(m.theme, m.accent)
		init = m
		initListeners.forEach(l => l(m))
	}
	else if (m.type === 'back') handleBack()
	else if (m.type === 'nav-reselect') reselectListeners.forEach(l => l(m.path))
	else if (m.type === 'path') pathListeners.forEach(l => l(m.path))
	else if (m.type === 'theme') applyTheme(m.theme, m.accent)
	// the app's window is back: the frame's own `focus`, as in the app (a hubby refreshing on it)
	else if (m.type === 'focus') window.dispatchEvent(new FocusEvent('focus'))
	else if (m.type === 'task') taskListeners.get(m.task.id)?.forEach(l => l(m.task))
	else if (m.type === 'state') {
		appState = m.state
		stateListeners.forEach(l => l(m.state))
	}
	else if (m.type === 'stream') streamListeners.get(m.stream)?.(m.event, m.data)
	else if (m.type === 'changed') changeListeners.get(m.collection)?.forEach(l => l(m.doc))
	else if (m.type === 'serve') void answer(m)
	else if (m.type === 'nav-action') navAction?.()
})

// --- its API, for the other hubbies (docs/plan-api-hubbies.md) ---

/** One of its API's methods: run in its frame, on what another hubby (`from`) sends. */
export type ApiHandler = (input: any, context: { from: string }) => unknown

let apiHandlers: Record<string, ApiHandler> = {}

/** The methods it offers (its definition's `api`; what api.json describes). */
export function serveApi(handlers: Record<string, ApiHandler>): void {
	apiHandlers = handlers
}

async function answer(m: Extract<HostMessage, { type: 'serve' }>) {
	const handler = Object.hasOwn(apiHandlers, m.method) ? apiHandlers[m.method] : undefined
	try {
		if (!handler) throw new Error(`this hubby has no method ${m.method}`)
		post({ type: 'served', id: m.id, ok: true, value: await handler(m.input, { from: m.from }) })
	}
	catch (err) {
		post({ type: 'served', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
	}
}

/** What each hubby offering an interface gave (or why it failed). */
export interface HubbyAnswer<T> {
	hubby: string
	result?: T
	error?: string
}

/**
 * The other hubbies' APIs (docs/plan-api-hubbies.md), within its scopes:
 *  - `call(hubby, method, input)`: a method of a named hubby (scope `hubby:<hubby>:<method>`);
 *  - `callAll(interface, input)`: every hubby offering that interface, without naming them (scope
 *    `hubby:<interface>`).
 * The host checks the input and the result against the offering hubby's api.json.
 */
export const hubbies = {
	call: <T = unknown>(hubby: string, method: string, input: unknown = {}) => call<T>('hubbies.call', hubby, method, input),
	callAll: <T = unknown>(method: string, input: unknown = {}) => call<Array<HubbyAnswer<T>>>('hubbies.callAll', method, input),
	/** Opens a page of another hubby (its path, a query allowed: one of its items). */
	open: (hubby: string, path: string) => call<null>('hubbies.open', hubby, path)
}

/**
 * The interface `timeline.items` (scope `hubby:timeline.items`), as the platform defines it: a
 * hubby's dated items between `start` and `end` (ISO date-times), each opening one of its pages
 * (`href`: its path, `hubbies.open`). Every hubby's answer is checked against it.
 */
export interface TimelineEntry {
	id: string
	/** ISO date-time */
	date: string
	title: string
	href: string
	/** #rrggbb */
	color?: string
}

/** The app's state, for this hubby (pushed by the host). */
export function useAppState(): AppState {
	const [value, setValue] = useState(appState)
	useEffect(() => {
		stateListeners.add(setValue)
		setValue(appState)
		return () => { stateListeners.delete(setValue) }
	}, [])
	return value
}

/** A request's options as they cross to the host: a JSON or text body, plain headers. */
function plainOptions(options: RequestInit = {}): { method?: string, headers?: Record<string, string>, body?: string } {
	if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') {
		throw new Error('a hubby\'s request body is a string (JSON): files go through the host')
	}
	const headers: Record<string, string> = {}
	new Headers(options.headers ?? {}).forEach((value, key) => { headers[key] = value })
	return { method: options.method, headers, body: (options.body as string | null | undefined) ?? undefined }
}

/** A call to the server's API, as the hubby (the host makes it): its JSON, an ApiError otherwise. */
export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	return call<T>('api', path, plainOptions(options))
}

let nextStream = 1

/** A server-sent event stream, as the hubby (the host reads it): resolves once it ends. */
export async function apiStream(path: string, options: RequestInit, onEvent: (event: string, data: unknown) => void): Promise<void> {
	const id = nextStream++
	const signal = options.signal
	const abort = () => { void call('stream.abort', id) }
	streamListeners.set(id, onEvent)
	signal?.addEventListener('abort', abort)
	try {
		if (signal?.aborted) return
		const { signal: _signal, ...rest } = options
		await call('stream.open', id, path, plainOptions(rest))
	}
	finally {
		streamListeners.delete(id)
		signal?.removeEventListener('abort', abort)
	}
}

// --- its AI models (client docs/plan-ia-moteur.md § 6) ---

export interface AiMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string
	/** a user's message to a vision model (its declared model has a projector, mmproj): images it shows (data: URLs, JPEG/PNG/WebP), at most 4 a request */
	images?: string[]
	/** an assistant's tool calls, sent back with their results */
	tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>
	/** a tool message: the call it answers */
	tool_call_id?: string
}

export interface AiTool { type: 'function', function: { name: string, description?: string, parameters?: Record<string, unknown> } }

export interface AiChatRequest {
	/** one of its models, by its name in its hubby.json "ai" */
	model: string
	messages: AiMessage[]
	tools?: AiTool[]
	temperature?: number
	/** at most 8192 (default 1024) */
	maxTokens?: number
	/** let a reasoning model think first (its thoughts: onReasoning); default false */
	reasoning?: boolean
	/** sampling: a role-play model's own settings (a Modelfile's top_p, min_p, repeat_penalty…) */
	topP?: number
	minP?: number
	repeatPenalty?: number
	repeatLastN?: number
	presencePenalty?: number
	/** at most 8 */
	stop?: string[]
	/** a chat template when the model's own doesn't fit it: chatml, llama3, mistral-v7, gemma, phi3, vicuna, zephyr, deepseek3 */
	template?: string
}

export interface AiToolCall { id: string, name: string, arguments: unknown, error?: string }

export interface AiChatResult {
	content: string
	toolCalls: AiToolCall[]
	finishReason: string | null
	/** `tokensPerSecond`: the engine's own speed (its generation alone) */
	usage: { promptTokens: number, completionTokens: number, tokensPerSecond?: number } | null
}

export interface AiChatOptions {
	/** the answer as it comes */
	onDelta?: (text: string) => void
	onReasoning?: (text: string) => void
	signal?: AbortSignal
}

/**
 * The AI models it declares (its hubby.json "ai"), run on the user's device — nothing leaves it
 * (scope `app:ai`; `platform.capabilities.localAi`). The first use asks the user to allow (and
 * download) the model; refused, the call fails.
 */
/** A model of a Hugging Face repo, as the device read it (`ai.models.inspect`). */
export interface AiRepoModel {
	name: string
	label: string
	files: Array<{ path: string, sha256: string, size: number }>
	sizeBytes: number
	requires: { vram: number, ram: number }
	fit: 'runs' | 'slow' | 'cannot'
	reason: string
}

export type AiImportKind = 'checkpoint' | 'lora' | 'audio'

/** A file imported for this hubby's AI on this device (`ai.files`). */
export interface AiImportedFile {
	sha256: string
	kind: AiImportKind
	name: string
	size: number
	/** a checkpoint's or a LoRA's family: a LoRA runs on a checkpoint of its family */
	family: 'sdxl' | 'sd1' | 'flux' | 'unknown' | null
	/** an audio sample's length */
	seconds: number | null
	users: string[]
}

export interface AiImageRequest {
	checkpoint: string
	loras?: Array<{ lora: string, strength?: number }>
	prompt: string
	negative?: string
	/** multiples of 64, 256-1536 (default 832 × 1216) */
	width?: number
	height?: number
	/** default 30 */
	steps?: number
	/** default 5 */
	cfg?: number
	/** stable-diffusion.cpp's names (default dpm++2m_sde, karras) */
	sampler?: string
	scheduler?: string
	seed?: number
	format?: 'jpeg' | 'png'
}

export interface AiImageResult { image: string, width: number, height: number, seed: number | null, seconds: number }

export interface AiSpeechRequest {
	model: string
	sample: string
	transcript: string
	text: string
	seed?: number
	temperature?: number
	language?: string
}

export interface AiSpeechResult { audio: string, seconds: number }

/** Pictures to embed: addresses on the Hubbyware server (its media proxy: what `api` gives). */
export interface AiEmbedImagesRequest { model: string, urls: string[] }
/** Each picture's vector (L2-normalised), null where it failed (`errors` says why). */
export interface AiEmbedImagesResult { vectors: Array<number[] | null>, errors: Array<string | null> }
/** A clip on the Hubbyware server, cut in `frames` stills spread over it (15 by default, at most 60). */
export interface AiEmbedVideoRequest { model: string, url: string, frames?: number }
export interface AiEmbedVideoResult { vectors: number[][], duration: number | null }

/** One of an AI assistant's tools: an API method of a hubby opened to it. */
export interface AgentTool {
	/** its name for an engine (hubby__method) */
	name: string
	hubby: string
	hubbyLabel: string
	method: string
	description: string
	/** its input's JSON Schema */
	input: unknown
	effect: 'read' | 'write' | 'outward'
}

/** One of the device's AI agents (`ai.agent.engines`). */
export interface AgentEngine {
	id: string
	label: string
	kind: 'claude' | 'acp'
	available: boolean
	version: string | null
	/** null: unknown */
	signedIn: boolean | null
	/** what the user should do first (in a terminal) */
	note: string | null
}

/** One of the account's devices (`ai.agent.devices`). */
export interface AgentDevice {
	id: string
	label: string
	detail: string | null
	online: boolean
	seenAt: string | null
	current: boolean
	engines: Array<{ id: string, label: string }>
}

export interface AgentRunRequest {
	engine: string
	/** the device whose engine runs it (`ai.agent.devices`: another one, the turn is relayed there, its go-aheads asked here); none: this one */
	device?: string | null
	conversation: string
	/** the user's new message */
	text: string
	/** the conversation so far, as plain text: used when the agent has no session of it on this device */
	transcript?: string | null
	instructions?: string | null
}

export interface AgentRunResult {
	content: string
	/** it went on with its own session (on this device) */
	resumed: boolean
	usage: { inputTokens?: number, outputTokens?: number, costUsd?: number } | null
}

export interface AgentRunOptions {
	onDelta?: (text: string) => void
	onCall?: (call: AgentCallResult & { input: unknown }) => void
	onDenied?: (tool: string) => void
	onStatus?: (kind: string, text: string) => void
	signal?: AbortSignal
}

/** What an assistant's call did (its trace). */
export interface AgentCallResult {
	tool: string
	hubby: string
	method: string
	effect: 'read' | 'write' | 'outward'
	confirmation: 'none' | 'allowed' | 'allowed-for-conversation' | 'denied'
	ok: boolean
	result?: unknown
	error?: string
}

/** A model added by link, as the hubby keeps it (`ai.models.set`). */
export interface AiUserModel { name: string, label: string, repo: string, revision: string, files: AiRepoModel['files'], requires: AiRepoModel['requires'] }

export const ai = {
	/**
	 * Models added from links the user gives (scope app:ai-links, an official hubby's): `inspect` reads a
	 * Hugging Face repo (by the device: its commit, its GGUF files with their sha256, how each fits);
	 * `set` hands the device all the models the hubby keeps (it then offers them as models of its own,
	 * by `name`, to allow and download as the declared ones). `available`: whether one of its models
	 * (declared, or added by link) can run on this device at all (scope app:ai) — a phone runs no
	 * image or vision model, nor one larger than its memory.
	 */
	models: {
		available: (name: string) => call<boolean>('ai.models.available', name),
		inspect: (link: string) => call<{ repo: string, revision: string, models: AiRepoModel[], selected: string | null }>('ai.models.inspect', link),
		set: (list: AiUserModel[]) => call<number>('ai.models.set', list)
	},
	/**
	 * An AI assistant on the user's other hubbies (scope app:agent, an official hubby's; client
	 * docs/plan-ia-agent.md): `tools` — the API methods of the hubbies the user opened to it (and their
	 * api.md); `call` — one of them, the app asking the user first for a `write` (once, or for the
	 * conversation) or an `outward` one (always); `access` / `setAccess` — the hubbies opened to it.
	 */
	agent: {
		tools: () => call<{ tools: AgentTool[], docs: Array<{ hubby: string, label: string, doc: string }> }>('agent.tools'),
		call: (conversation: string, tool: string, input: unknown) => call<AgentCallResult>('agent.call', conversation, tool, input),
		access: () => call<{ opened: string[], hubbies: Array<{ hubby: string, label: string, methods: number, writes: boolean, outward: boolean }> }>('agent.access'),
		setAccess: (ids: string[]) => call<string[]>('agent.setAccess', ids),
		/** the device's AI agents that may be a conversation's engine (desktop: Claude Code) */
		engines: () => call<AgentEngine[]>('agent.engines'),
		/** the account's devices (this one: current), up or not, and the engines each offers (a turn may run on one) */
		devices: () => call<AgentDevice[]>('agent.devices'),
		/** this device's id among them */
		thisDevice: () => call<string | null>('agent.thisDevice'),
		/**
		 * A turn with one of them: its text as it comes (onDelta), Hubbyware's record of each call it
		 * made (onCall: the trace to keep), the tools it tried that aren't Hubbyware's (onDenied).
		 */
		async run(request: AgentRunRequest, options: AgentRunOptions = {}): Promise<AgentRunResult> {
			const id = nextStream++
			const abort = () => { void call('stream.abort', id) }
			streamListeners.set(id, (event, data) => {
				if (event === 'delta') options.onDelta?.(String(data))
				else if (event === 'call') options.onCall?.(data as AgentCallResult & { input: unknown })
				else if (event === 'denied') options.onDenied?.(String(data))
				else if (event === 'tool' || event === 'status') options.onStatus?.(String(event), String(data))
			})
			options.signal?.addEventListener('abort', abort)
			try {
				return await call<AgentRunResult>('agent.run', id, request)
			}
			finally {
				streamListeners.delete(id)
				options.signal?.removeEventListener('abort', abort)
			}
		}
	},
	/**
	 * An image (client docs/plan-ia-compagnon.md): an image model the user imported for this hubby (a
	 * checkpoint, by its sha256), LoRA it imported (of the same family), the prompt; the platform adds
	 * its safety negative to every image and refuses a prompt naming a minor. A JPEG data: URL by default.
	 */
	async image(request: AiImageRequest, options: { signal?: AbortSignal } = {}): Promise<AiImageResult> {
		const id = nextStream++
		const abort = () => { void call('stream.abort', id) }
		options.signal?.addEventListener('abort', abort)
		try { return await call<AiImageResult>('ai.image', id, request) }
		finally { options.signal?.removeEventListener('abort', abort) }
	},
	/**
	 * Speech in a voice: a voice model it declares (hubby.json "ai", family voice), conditioned by a
	 * sample the user imported for it (a WAV, by its sha256) and what it says; a fixed seed keeps the
	 * voice even. A WAV data: URL (24 kHz mono). The first use asks the user like a chat's model.
	 */
	async speech(request: AiSpeechRequest, options: { signal?: AbortSignal } = {}): Promise<AiSpeechResult> {
		const id = nextStream++
		const abort = () => { void call('stream.abort', id) }
		options.signal?.addEventListener('abort', abort)
		try { return await call<AiSpeechResult>('ai.speech', id, request) }
		finally { options.signal?.removeEventListener('abort', abort) }
	},
	/**
	 * Image vectors on the desktop's GPU (one of the hubby's models, family embed; scope app:ai;
	 * docs/plan-auto-desktop.md): of pictures, or of a clip's stills. The files must be on the
	 * Hubbyware server (its media proxy). The first use asks the user like a chat's model.
	 */
	embedImages: (request: AiEmbedImagesRequest): Promise<AiEmbedImagesResult> => call<AiEmbedImagesResult>('ai.embedImages', request),
	embedVideo: (request: AiEmbedVideoRequest): Promise<AiEmbedVideoResult> => call<AiEmbedVideoResult>('ai.embedVideo', request),
	/** Files the user imports for this hubby (a file dialog: their consent), on this device. */
	files: {
		/** null: cancelled */
		import: (kind: AiImportKind) => call<AiImportedFile | null>('ai.files.import', kind),
		list: () => call<AiImportedFile[]>('ai.files.list')
	},
	async chat(request: AiChatRequest, options: AiChatOptions = {}): Promise<AiChatResult> {
		const id = nextStream++
		const abort = () => { void call('stream.abort', id) }
		streamListeners.set(id, (event, data) => {
			if (event === 'delta') options.onDelta?.(String(data))
			else if (event === 'reasoning') options.onReasoning?.(String(data))
		})
		options.signal?.addEventListener('abort', abort)
		try {
			return await call<AiChatResult>('ai.chat', id, request)
		}
		finally {
			streamListeners.delete(id)
			options.signal?.removeEventListener('abort', abort)
		}
	}
}

/** Called with a document's id each time one of the collection changes (here or elsewhere). */
export function watchCollection(name: string, listener: (id: string) => void): () => void {
	let set = changeListeners.get(name)
	if (!set) {
		changeListeners.set(name, set = new Set())
		void call('collection.watch', name)
	}
	set.add(listener)
	return () => {
		set.delete(listener)
		if (set.size === 0) {
			changeListeners.delete(name)
			void call('collection.unwatch', name)
		}
	}
}

/** A call to the host (the platform API, through it). */
export function call<T>(method: string, ...args: unknown[]): Promise<T> {
	const id = nextId++
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
		post({ type: 'call', id, method, args })
	})
}

/** The host's `init`, as received (null before it). */
export function currentInit(): Extract<HostMessage, { type: 'init' }> | null {
	return init
}

export function useInit() {
	const [value, setValue] = useState(init)
	useEffect(() => {
		initListeners.add(setValue)
		setValue(init) // it may have come before this component listened
		return () => { initListeners.delete(setValue) }
	}, [])
	return value
}

export function usePath(): string {
	const [path, setPath] = useState(init?.path ?? '/')
	useEffect(() => {
		pathListeners.add(setPath)
		const onInit = (m: { path: string }) => setPath(m.path)
		initListeners.add(onInit)
		if (init) setPath(init.path)
		return () => { pathListeners.delete(setPath); initListeners.delete(onInit) }
	}, [])
	return path
}

let navAction: (() => void) | null = null

/** One link of its live navigation: a path of its own, its label, the section it sits under. */
export interface NavEntry { path: string, label: string, section?: string }

export const nav = {
	navigate(path: string) {
		post({ type: 'navigate', path })
	},
	/**
	 * Its live navigation, set again whenever it changes (the AI hubby's conversations): links after
	 * its pages in the app's column, under their sections, an action at the top (`action.onClick` when
	 * clicked), a search field over them (`search`: its placeholder). Not in a phone's bottom bar: show
	 * them in a page there. At most 500 links.
	 */
	setItems(items: NavEntry[], options: { action?: { label: string, onClick: () => void }, search?: string } = {}) {
		navAction = options.action?.onClick ?? null
		post({ type: 'nav', items: items.slice(0, 500), action: options.action ? { label: options.action.label } : null, search: options.search ?? null })
	},
	/** No live navigation any more. */
	clearItems() {
		navAction = null
		post({ type: 'nav', items: [], action: null, search: null })
	}
}

export interface Doc { id: string, [field: string]: unknown }

/** A collection of the hubby (the generic API, through the host). */
export function collection(name: string) {
	return {
		find: () => call<Doc[]>('collection.find', name),
		create: (doc: Record<string, unknown>) => call<Doc>('collection.create', name, doc),
		remove: (id: string) => call<void>('collection.remove', name, id)
	}
}

export const settings = {
	/** a real API call made by the host (measures a network round trip) */
	account: () => call<Record<string, unknown>>('settings.account')
}

export const notifications = {
	upsert: (n: { key: string, title: string, body?: string }) => call<void>('notifications.upsert', n)
}

/** Announces the hubby's pages to its host (it builds the navigation). */
/** An account connected at a provider, as the hubby sees it (its grant covers what it declares: `ready`). */
export interface OAuthConnection { id: string, provider: string, email: string, name: string | null, ready: boolean, lastError: string | null }

/**
 * The account's connections at a provider (Google, Microsoft), for what the hubby declares
 * (hubby.json `oauth`; the account allowing it `app:oauth:<provider>`): through the host, as the hubby.
 */
export const oauth = {
	connections: () => call<OAuthConnection[]>('oauth.connections'),
	/**
	 * the consent opens in the browser; resolves once the account consented. `signal`: stops
	 * waiting here (an AbortSignal can't cross to the host: the consent page stays open there)
	 */
	connect: (provider: string, options: { connection?: string, signal?: AbortSignal } = {}) => {
		const { signal, ...rest } = options
		const consented = call<OAuthConnection | null>('oauth.connect', provider, rest)
		if (!signal) return consented
		return Promise.race([consented, new Promise<never>((_, reject) => {
			const abort = () => reject(new DOMException('The connection was cancelled', 'AbortError'))
			if (signal.aborted) abort()
			else signal.addEventListener('abort', abort, { once: true })
		})])
	},
	/** an access token, for the hubby's scopes only */
	accessToken: (connection: string) => call<{ accessToken: string, expiresAt: number }>('oauth.accessToken', connection),
}

export type { TaskState }

const finished = (state: TaskState) => state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled'

/** A task of the hubby, through its host: followed by a hook or a stream, then its result. */
export interface Task {
	readonly id: string
	readonly state: TaskState
	on(listener: (state: TaskState) => void): () => void
	events(signal?: AbortSignal): AsyncIterableIterator<TaskState>
	result<T>(): Promise<T>
	cancel(): Promise<TaskState>
}

function frameTask(initial: TaskState): Task {
	let state = initial
	const on = (listener: (state: TaskState) => void) => {
		listener(state)
		if (finished(state)) return () => {}
		let set = taskListeners.get(state.id)
		if (!set) {
			taskListeners.set(state.id, set = new Set())
			void call('tasks.follow', state.id)
		}
		const wrapped = (next: TaskState) => { state = next; listener(next) }
		set.add(wrapped)
		return () => {
			set.delete(wrapped)
			if (set.size === 0) {
				taskListeners.delete(state.id)
				void call('tasks.unfollow', state.id)
			}
		}
	}
	return {
		id: state.id,
		get state() { return state },
		on,
		async *events(signal?: AbortSignal) {
			const queue: TaskState[] = []
			let wake: (() => void) | null = null
			const stop = on(s => { queue.push(s); wake?.() })
			const abort = () => wake?.()
			signal?.addEventListener('abort', abort)
			try {
				while (!signal?.aborted) {
					if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
					wake = null
					while (queue.length > 0) {
						const s = queue.shift()!
						yield s
						if (finished(s)) return
					}
				}
			}
			finally {
				stop()
				signal?.removeEventListener('abort', abort)
			}
		},
		result: <T>() => call<T>('tasks.result', state.id),
		cancel: async () => (state = await call<TaskState>('tasks.cancel', state.id))
	}
}

/**
 * The hubby's tasks (server docs/plan-tasks.md): a capability's call (/api/cap/…) run in the
 * background by the host, as the hubby; followed live, its result read once finished.
 */
export const tasks = {
	/** `options`: the call's method, JSON body (a string) and headers */
	start: async (path: string, options: { method?: string, body?: string, headers?: Record<string, string> } = {}) =>
		frameTask(await call<TaskState>('tasks.start', path, options)),
	get: async (id: string) => frameTask(await call<TaskState>('tasks.get', id)),
	list: (status?: TaskState['status']) => call<TaskState[]>('tasks.list', status)
}

export function register(pages: HubbyPage[], sections: Record<string, unknown>) {
	post({ type: 'register', pages, sections })
}

/** Wires the frame to its host: ready, back depth, keys the app listens to (Ctrl+Alt…). */
export function connect() {
	onBackDepth(depth => post({ type: 'back-depth', depth }))
	window.addEventListener('keydown', e => {
		if (e.ctrlKey || e.altKey || e.metaKey) {
			post({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
		}
	})
	post({ type: 'ready', at: performance.now() })
}
