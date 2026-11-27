import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, ApiError } from '@core/api/client'
import { getApiBaseUrl } from '@core/api/baseUrl'
import { collection } from './collections'
import { createOAuth } from './oauth'
import { hubbyApi } from './tokens'
import type { Task } from '@core/api/tasks'
import { hasScope, useHubbyScopes } from '@core/hubbies/scopes'
import { useBackHandler, useMediaQuery } from '@cxxi-lab/hubbyware-ui'
import { platform } from '@platform'
import { PROTOCOL, type Envelope, type GuestMessage, type HostMessage } from '@cxxi-lab/hubbyware-sdk/protocol'
import { onPageReselect, setHubbyLiveNav, setHubbyNav } from './navs'
import { currentAccent, currentTheme, useAccent, useTheme } from '@core/theme/theme'
import { useAmountsBlurred, useBlurEpoch, useHubbyVisible, usePrivateMode } from '@core/privacy/hidden'
import { useVpnStatus } from '@shared/hooks/useVpnStatus'
import type { AppState, CallError, SurfaceState } from '@cxxi-lab/hubbyware-sdk/protocol'
import { storageSet, storageSnapshot } from './storage'
import { NativeSurfaceViews, SurfaceViews, surfaceMethods, type WebviewElement } from './HubbySurfaces'
import { callAll, callHubby, isAvailable, served, serveFrom } from './apis'
import { askModelConsent } from '@core/ai/ModelConsent'
import { agentCall, agentTools, assistantHubbies, hubbiesWithApis, setAssistantHubbies } from '@core/ai/agent'
import { onAgentCall } from '@core/ai/agentBridge'
import { remoteDevices, remoteRun, thisDevice } from '@core/ai/remote'
import type { AgentRunRequest } from '@platform'
import type { AiChatRequest } from '@platform'

// ai.chat's ids, unique across the frames (the main process tells their answers apart by them)
let nextChat = 1

/** What a frame learns of the shell (its URL: a manifest reads it as it loads). */
function frameCapabilities(): string {
	return Object.entries(platform.capabilities).filter(([, on]) => on === true).map(([name]) => name).join(',')
}

/** The calls a frame may make to the server, as its hubby (the server checks what it declares). */
const API_PATHS = /^\/api\/cap\//

/** A request's options from a frame: a method, plain headers, a string body; nothing else. */
function requestOptions(options: unknown): RequestInit {
	const o = (options ?? {}) as { method?: unknown, headers?: unknown, body?: unknown }
	const headers = Object.fromEntries(Object.entries((o.headers ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
	return { method: typeof o.method === 'string' ? o.method : undefined, headers, body: typeof o.body === 'string' ? o.body : undefined }
}

function apiPath(path: unknown): string {
	if (typeof path !== 'string' || !API_PATHS.test(path)) throw new Error('a hubby calls its capabilities (/api/cap/…)')
	return path
}

/**
 * An isolated hubby (docs/plan-hubby-architecture.md § 4 ter): its frame — a sandboxed iframe
 * with an opaque origin, loaded from the platform's hubby address (desktop hubby://<id>/, Android
 * https://<id>.hubby.localhost/) — and the host side of its messages: its pages become the app's
 * navigation, its calls are made with the session, only within the scopes the account allowed it.
 * `headless`: a frame started only to answer its API (apis.ts): unseen, no page, no navigation.
 */
export function HubbyHost({ hubby, headless = false, background = false }: { hubby: string, headless?: boolean, background?: boolean }) {
	const frame = useRef<HTMLIFrameElement>(null)
	const navigate = useNavigate()
	const { pathname, search } = useLocation()
	const phone = useMediaQuery('(width < 40rem)')
	const scopes = useHubbyScopes()
	const [backDepth, setBackDepth] = useState(0)
	const base = `/${hubby}`
	// its page, with its query (a link to one of its items: `?session=…`)
	const page = pathname === base ? '/' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
	const inner = page === null ? null : page + search
	const base_ = platform.hubbyUrl(hubby)
	const src = base_ ? `${base_}?capabilities=${frameCapabilities()}${headless ? '&headless' : ''}${headless && background ? '&background' : ''}` : null
	// its web surfaces (D3): the webviews shown over the frame
	const [surfaceStates, setSurfaceStates] = useState<Record<number, SurfaceState>>({})
	// development: its files built again (`hubby dev`): the frame loads them (a new frame)
	const [build, setBuild] = useState(0)
	useEffect(() => platform.onHubbyFilesChange(changed => {
		if (changed !== hubby) return
		// the former frame's surfaces go with it (the new one opens its own)
		setSurfaceStates({})
		setBuild(b => b + 1)
	}), [hubby])
	const surfaceElements = useRef(new Map<number, WebviewElement>()).current

	// the app's state, as the frame gets it (pushed at each change)
	const vpn = useVpnStatus()
	const appState: AppState = {
		phone,
		privateMode: usePrivateMode(),
		visible: useHubbyVisible(hubby),
		amountsBlurred: useAmountsBlurred(hubby),
		blurEpoch: useBlurEpoch(),
		tunnelReady: vpn.status === 'connected' && (vpn.hubby == null || vpn.hubby === hubby)
	}

	// the latest values the message handler reads (it is set up once)
	const state = useRef({ inner, phone, scopes, appState })
	state.current = { inner, phone, scopes, appState }

	const send = (message: HostMessage) => {
		const envelope: Envelope<HostMessage> = { protocol: PROTOCOL, message }
		// an opaque origin: '*' is the only target; the frame's window is the one it reaches
		frame.current?.contentWindow?.postMessage(envelope, '*')
	}

	useBackHandler(!headless && backDepth > 0, () => send({ type: 'back' }))
	useEffect(() => { if (!headless && inner !== null) send({ type: 'path', path: inner }) }, [inner])
	const theme = useTheme()
	const accent = useAccent()
	useEffect(() => { send({ type: 'theme', theme, accent }) }, [theme, accent])
	// one of its pages tapped again in the bottom bar: told to it
	useEffect(() => {
		if (headless) return
		return onPageReselect(path => { if (path === `/${hubby}` || path.startsWith(`/${hubby}/`)) send({ type: 'nav-reselect', path }) })
	}, [hubby, headless])
	// the app's window back: told to the frame (its own focus event doesn't fire then)
	useEffect(() => {
		const onFocus = () => send({ type: 'focus' })
		window.addEventListener('focus', onFocus)
		return () => window.removeEventListener('focus', onFocus)
	}, [])
	const stateKey = JSON.stringify(appState)
	useEffect(() => { send({ type: 'state', state: appState }) }, [stateKey])

	useEffect(() => {
		const granted = (scope: string) => hasScope(state.current.scopes, hubby, scope)
		const embedMedia = async (kind: 'embedImages' | 'embedVideo', request: unknown) => {
			if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
			const run = platform.localAi?.[kind]
			if (!run) throw new Error('unavailable: image vectors are made on a desktop only')
			const r = (request ?? {}) as { model?: unknown, url?: unknown, urls?: unknown }
			// only the Hubbyware server's files (a hubby can't have the app fetch elsewhere)
			const server = new URL(getApiBaseUrl()).origin
			const urls = kind === 'embedImages' ? (Array.isArray(r.urls) ? r.urls : []) : [r.url]
			for (const u of urls) {
				let origin = ''
				try { origin = new URL(String(u)).origin } catch { /* not an address */ }
				if (origin !== server) throw new Error(`invalid: ${String(u).slice(0, 80)} is not on the Hubbyware server`)
			}
			for (let attempt = 0; ; attempt++) {
				const out = await run(hubby, request)
				if (out.ok) return out.result
				if ((out.code === 'consent' || out.code === 'missing') && attempt === 0 && typeof r.model === 'string' && await askModelConsent(hubby, r.model)) continue
				throw new Error(`${out.code}: ${out.message}`)
			}
		}
		// its own collections, through the app's client: their encrypted fields sealed here, by the
		// host (the frame never sees the data key)
		const own = (name: unknown) => {
			if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error('invalid collection name')
			return collection<Record<string, unknown>>(hubby, name)
		}
		// its connections at a provider: as the hubby (its token), the server checking what it declares
		const oauth = createOAuth((path, options) => hubbyApi(hubby).api(path, options))
		// its tasks (server docs/plan-tasks.md): its capabilities' calls, as the hubby (the server
		// checks what it declares); the host keeps the tasks the frame asked about, and pushes the
		// changes of those it follows
		const tasks = hubbyApi(hubby).tasks
		const held = new Map<string, Task>()
		// its server calls and streams, as the hubby
		const caller = hubbyApi(hubby)
		const streams = new Map<number, AbortController>()
		// the collections whose changes it follows
		const watching = new Map<string, () => void>()
		const docs = (name: unknown) => own(name) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
		// the native player (Android): relayed, its events pushed once the frame listens
		const playerOffs: Array<() => void> = []
		const following = new Map<string, () => void>()
		const hold = (task: Task) => { held.set(task.id, task); return task.state }
		const heldTask = async (id: unknown): Promise<Task> => {
			if (typeof id !== 'string') throw new Error('invalid task id')
			const known = held.get(id)
			if (known) return known
			const task = await tasks.get(id)
			held.set(task.id, task)
			return task
		}
		// what a hubby may ask its host: its own collections and settings (no scope), the rest by scope
		const methods: Record<string, (...args: unknown[]) => unknown> = {
			'echo': (v: unknown) => v,
			'collection.find': async (name: unknown) => (await own(name).find({ limit: 200 })).data,
			'collection.create': (name: unknown, doc: unknown) => own(name).create((doc ?? {}) as Record<string, unknown>),
			'collection.remove': (name: unknown, id: unknown) => own(name).remove(encodeURIComponent(String(id))),
			'settings.account': () => {
				if (!granted('user:profile')) throw new Error('scope_denied: user:profile')
				return api<{ data?: unknown }>('/api/hub/settings/account').then(r => r.data)
			},
			'oauth.connections': () => oauth.connections(),
			'oauth.connect': (provider: unknown, options: unknown) => {
				const connection = (options as { connection?: unknown } | undefined)?.connection
				return oauth.connect(String(provider), { connection: typeof connection === 'string' ? connection : undefined })
			},
			'oauth.accessToken': (connection: unknown) => oauth.accessToken(String(connection)),
			'tasks.start': async (path: unknown, options: unknown) => {
				if (typeof path !== 'string' || !path.startsWith('/api/cap/')) throw new Error('a task is a capability\'s call (/api/cap/…)')
				const o = (options ?? {}) as { method?: unknown, body?: unknown, headers?: unknown }
				const headers = Object.fromEntries(Object.entries((o.headers ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
				return hold(await tasks.start(path, { method: typeof o.method === 'string' ? o.method : 'POST', body: typeof o.body === 'string' ? o.body : undefined, headers }))
			},
			'tasks.get': async (id: unknown) => (await heldTask(id)).state,
			'tasks.list': (status: unknown) => tasks.list(typeof status === 'string' ? status as never : undefined),
			'tasks.result': async (id: unknown) => (await heldTask(id)).result(),
			'tasks.cancel': async (id: unknown) => (await heldTask(id)).cancel(),
			'tasks.follow': async (id: unknown) => {
				const task = await heldTask(id)
				if (!following.has(task.id)) following.set(task.id, task.on(state => send({ type: 'task', task: state })))
				return null
			},
			'tasks.unfollow': (id: unknown) => {
				if (typeof id === 'string') { following.get(id)?.(); following.delete(id) }
				return null
			},
			'api': (path: unknown, options: unknown) => caller.api(apiPath(path), requestOptions(options)),
			'stream.open': (id: unknown, path: unknown, options: unknown) => {
				if (typeof id !== 'number') throw new Error('invalid stream id')
				const controller = new AbortController()
				streams.set(id, controller)
				return caller.apiStream(apiPath(path), { ...requestOptions(options), signal: controller.signal }, (event, data) => send({ type: 'stream', stream: id, event, data }))
					.finally(() => streams.delete(id))
			},
			'stream.abort': (id: unknown) => {
				if (typeof id === 'number') streams.get(id)?.abort()
				return null
			},
			// its collections, whole (docs/plan-isolation.md § 2)
			...Object.fromEntries(['find', 'findAll', 'get', 'create', 'createWithId', 'update', 'replace', 'remove', 'batch'].map(m => [
				`collections.${m}`, (name: unknown, ...args: unknown[]) => docs(name)[m](...args)
			])),
			'collection.watch': (name: unknown) => {
				const key = String(name)
				if (!watching.has(key)) watching.set(key, own(name).onChange(doc => send({ type: 'changed', collection: key, doc })))
				return null
			},
			'collection.unwatch': (name: unknown) => {
				watching.get(String(name))?.()
				watching.delete(String(name))
				return null
			},
			// its own storage on this device (its frame has none)
			'storage.set': (key: unknown, value: unknown) => { storageSet(hubby, String(key), value === null ? null : String(value)); return null },
			// the native player (Android, capabilities.nativePlayer)
			...(platform.capabilities.nativePlayer ? {
				'player.open': (options: unknown) => platform.player.open(options as Parameters<typeof platform.player.open>[0]),
				'player.exec': (script: unknown) => platform.player.exec(String(script)),
				'player.reload': () => platform.player.reload(),
				'player.close': () => platform.player.close(),
				'player.setActions': (actions: unknown, icons: unknown) => platform.player.setActions(actions as never, icons as never),
				'player.showPanel': (panel: unknown) => platform.player.showPanel(panel as never),
				'player.listen': () => {
					if (playerOffs.length) return null
					playerOffs.push(
						platform.player.onReady(() => send({ type: 'player', event: 'ready' })),
						platform.player.onClosed(() => send({ type: 'player', event: 'closed' })),
						platform.player.onAction(id => send({ type: 'player', event: 'action', value: id })),
						platform.player.onNavigate(direction => send({ type: 'player', event: 'navigate', value: direction }))
					)
					return null
				}
			} : {}),
			// its web surfaces (desktop: capabilities.webview)
			...surfaceMethods((id, next) => setSurfaceStates(prev => {
				const copy = { ...prev }
				if (next) copy[id] = next
				else delete copy[id]
				return copy
			}), surfaceElements, (path, options) => caller.api(path, options), async (surfaceId, request) => {
				// its vector needs an image model of its own (scope app:ai); the picture alone, none
				const model = (request as { model?: unknown } | null)?.model
				if (model !== undefined && !granted('app:ai')) throw new Error('scope_denied: app:ai')
				const take = platform.localAi?.snapshot
				if (!take) throw new Error('unavailable: a surface\'s picture is taken on a desktop only')
				for (let attempt = 0; ; attempt++) {
					const out = await take(hubby, surfaceId, request)
					if (out.ok) return out.result
					if ((out.code === 'consent' || out.code === 'missing') && attempt === 0 && typeof model === 'string' && await askModelConsent(hubby, model)) continue
					throw new Error(`${out.code}: ${out.message}`)
				}
			}),
			// the other hubbies' APIs (docs/plan-api-hubbies.md), within its scopes
			'hubbies.call': (target: unknown, method: unknown, input: unknown) => {
				if (typeof target !== 'string' || typeof method !== 'string') throw new Error('hubbies.call(hubby, method, input)')
				const scope = `hubby:${target}:${method}`
				if (!granted(scope)) throw new Error(`scope_denied: ${scope}`)
				return callHubby(hubby, target, method, input)
			},
			'hubbies.callAll': (method: unknown, input: unknown) => {
				if (typeof method !== 'string') throw new Error('hubbies.callAll(interface, input)')
				const scope = `hubby:${method}`
				if (!granted(scope)) throw new Error(`scope_denied: ${scope}`)
				return callAll(hubby, method, input)
			},
			// a page of another hubby (an item of its, shown here: Planner's calendar)
			'hubbies.open': (target: unknown, path: unknown) => {
				if (typeof target !== 'string' || typeof path !== 'string' || !path.startsWith('/')) throw new Error('hubbies.open(hubby, path)')
				if (!isAvailable(target)) throw new Error(`${target} is not available`)
				if (!headless) navigate(`/${target}${path === '/' ? '' : path}`)
				return null
			},
			// a model of its own on this device (client docs/plan-ia-moteur.md § 6): its answer streams
			// as `stream` events of `id`; the first use asks the user (the model allowed, downloaded)
			'ai.chat': async (id: unknown, request: unknown) => {
				if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
				const ai = platform.localAi
				if (!ai) throw new Error('local AI is not available on this device')
				if (typeof id !== 'number') throw new Error('invalid stream id')
				const chatId = nextChat++
				const controller = new AbortController()
				streams.set(id, controller)
				controller.signal.addEventListener('abort', () => ai.abort(chatId))
				const off = ai.onEvent(e => { if (e.id === chatId) send({ type: 'stream', stream: id, event: e.kind, data: e.text }) })
				try {
					for (let attempt = 0; ; attempt++) {
						const out = await ai.chat(chatId, hubby, request as AiChatRequest)
						if (out.ok) return out.result
						const model = (request as { model?: unknown } | null)?.model
						if ((out.code === 'consent' || out.code === 'missing') && attempt === 0 && typeof model === 'string' && await askModelConsent(hubby, model)) continue
						throw new Error(`${out.code}: ${out.message}`)
					}
				}
				finally {
					off()
					streams.delete(id)
				}
			},
			// an image (ai.image) or speech in a voice (ai.speech), on this device (scope app:ai); the voice
			// model asked like a chat's; the files they use, imported by the user for this hubby
			'ai.image': async (id: unknown, request: unknown) => {
				if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
				const ai = platform.localAi
				if (!ai) throw new Error('local AI is not available on this device')
				if (typeof id !== 'number') throw new Error('invalid stream id')
				const runId = nextChat++
				const controller = new AbortController()
				streams.set(id, controller)
				controller.signal.addEventListener('abort', () => ai.abort(runId))
				try {
					const out = await ai.image(runId, hubby, request)
					if (out.ok) return out.result
					throw new Error(`${out.code}: ${out.message}`)
				}
				finally {
					streams.delete(id)
				}
			},
			'ai.speech': async (id: unknown, request: unknown) => {
				if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
				const ai = platform.localAi
				if (!ai) throw new Error('local AI is not available on this device')
				if (typeof id !== 'number') throw new Error('invalid stream id')
				const runId = nextChat++
				const controller = new AbortController()
				streams.set(id, controller)
				controller.signal.addEventListener('abort', () => ai.abort(runId))
				try {
					for (let attempt = 0; ; attempt++) {
						const out = await ai.speech(runId, hubby, request)
						if (out.ok) return out.result
						const model = (request as { model?: unknown } | null)?.model
						if ((out.code === 'consent' || out.code === 'missing') && attempt === 0 && typeof model === 'string' && await askModelConsent(hubby, model)) continue
						throw new Error(`${out.code}: ${out.message}`)
					}
				}
				finally {
					streams.delete(id)
				}
			},
			// image vectors of pictures and clips on the Hubbyware server (its media proxy), by the
			// desktop's GPU (scope app:ai: docs/plan-auto-desktop.md); the first use asks the user
			'ai.embedImages': (request: unknown) => embedMedia('embedImages', request),
			'ai.embedVideo': (request: unknown) => embedMedia('embedVideo', request),
			'ai.files.import': (kind: unknown) => {
				if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
				if (!platform.localAi) throw new Error('local AI is not available on this device')
				if (!['checkpoint', 'lora', 'audio'].includes(String(kind))) throw new Error('ai.files.import(checkpoint | lora | audio)')
				return platform.localAi.importFile(hubby, kind as 'checkpoint' | 'lora' | 'audio')
			},
			'ai.files.list': () => {
				if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
				return platform.localAi ? platform.localAi.importedFiles(hubby) : []
			},
			// models added from links the user gives (scope app:ai-links: an official hubby's): the repo read by
			// the device, never by the frame
			// whether one of its models can run on this device (a variant fits: the platform decides)
			'ai.models.available': async (name: unknown) => {
				if (!granted('app:ai')) throw new Error('scope_denied: app:ai')
				if (!platform.localModels || typeof name !== 'string') return false
				const plan = (await platform.localModels.state()).plans.find(p => p.hubby === hubby && p.name === name)
				return !!plan && !plan.invalid && plan.chosen !== null
			},
			'ai.models.inspect': (link: unknown) => {
				if (!granted('app:ai-links')) throw new Error('scope_denied: app:ai-links')
				if (!platform.localModels) throw new Error('local AI is not available on this device')
				return platform.localModels.inspect(String(link).slice(0, 500))
			},
			'ai.models.set': (list: unknown) => {
				if (!granted('app:ai-links')) throw new Error('scope_denied: app:ai-links')
				if (!platform.localModels) return 0
				return platform.localModels.setUserModels(hubby, list as never)
			},
			// an AI assistant acting on the user's other hubbies (scope app:agent, an official hubby's):
			// the tools of the hubbies opened to it, each call confirmed by the app (write, outward)
			'agent.tools': () => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				return agentTools(hubby)
			},
			'agent.call': (conversation: unknown, tool: unknown, input: unknown) => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				if (typeof conversation !== 'string' || typeof tool !== 'string') throw new Error('agent.call(conversation, tool, input)')
				return agentCall(hubby, conversation, tool, input)
			},
			'agent.access': async () => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				return { opened: await assistantHubbies(), hubbies: hubbiesWithApis().filter(h => h.hubby !== hubby) }
			},
			// the device's AI agents as the conversation's engine (desktop): which are here, a turn with one —
			// its text streamed, and Hubbyware's own record of every call it made (the trace)
			'agent.engines': async () => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				return platform.agentBridge ? platform.agentBridge.engines() : []
			},
			// the account's devices and the engines each offers (this one: current; the remote engine)
			'agent.devices': async () => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				return remoteDevices()
			},
			'agent.thisDevice': async () => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				return thisDevice()
			},
			'agent.run': async (id: unknown, request: unknown) => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				if (typeof id !== 'number') throw new Error('invalid stream id')
				const req = request as AgentRunRequest
				// on another of the account's devices: relayed there, sealed (its go-aheads asked here)
				if (req?.device && req.device !== await thisDevice()) {
					const controller = new AbortController()
					streams.set(id, controller)
					try {
						return await remoteRun(req.device, hubby, req, {
							signal: controller.signal,
							onEvent: (kind, text) => send({ type: 'stream', stream: id, event: kind, data: text }),
							onCall: call => send({ type: 'stream', stream: id, event: 'call', data: call })
						})
					}
					finally {
						streams.delete(id)
					}
				}
				const bridge = platform.agentBridge
				if (!bridge) throw new Error('device agents are not available on this device')
				const runId = nextChat++
				const controller = new AbortController()
				streams.set(id, controller)
				controller.signal.addEventListener('abort', () => bridge.abort(runId))
				const off = bridge.onEvent(e => { if (e.id === runId) send({ type: 'stream', stream: id, event: e.kind, data: e.text }) })
				const offCalls = onAgentCall((conversation, call) => { if (conversation === req?.conversation) send({ type: 'stream', stream: id, event: 'call', data: call }) })
				try {
					return await bridge.run(runId, hubby, req)
				}
				finally {
					off()
					offCalls()
					streams.delete(id)
				}
			},
			'agent.setAccess': (ids: unknown) => {
				if (!granted('app:agent')) throw new Error('scope_denied: app:agent')
				return setAssistantHubbies(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [])
			},
			'notifications.upsert': () => {
				if (!granted('app:notifications')) throw new Error('scope_denied: app:notifications')
				return null
			}
		}

		// this frame answers its API's calls once it is ready (again, after a new build)
		let stopServing: (() => void) | null = null

		const onMessage = async (event: MessageEvent) => {
			// only this frame's messages (an opaque origin can't be checked: its window can)
			if (!frame.current || event.source !== frame.current.contentWindow) return
			const data = event.data as Envelope<GuestMessage> | undefined
			if (data?.protocol !== PROTOCOL) return
			const m = data.message
			switch (m.type) {
				case 'ready':
					send({ type: 'init', hubby, path: state.current.inner ?? '/', phone: state.current.phone, scopes: [], theme: currentTheme(), accent: currentAccent(), apiBase: getApiBaseUrl(), storage: storageSnapshot(hubby) })
					send({ type: 'state', state: state.current.appState })
					stopServing?.()
					// a new frame (started again): its live navigation is the one it sets
					if (!headless) setHubbyLiveNav(hubby, null)
					stopServing = serveFrom(hubby, { headless, serve: (id, method, input, from) => send({ type: 'serve', id, method, input, from }) })
					break
				case 'register':
					if (!headless) setHubbyNav(hubby, m.pages, m.sections)
					break
				case 'nav': {
					if (headless) break
					// its live navigation, checked: links of its own pages, short labels, at most 500
					const text = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : ''
					const items = (Array.isArray(m.items) ? m.items : []).slice(0, 500)
						.filter(i => typeof i?.path === 'string' && i.path.startsWith('/') && !i.path.includes('..'))
						.map(i => ({ to: `${base}${i.path === '/' ? '' : i.path}`, label: text(i.label, 120) || i.path, section: text(i.section, 40) || undefined, end: true, live: true }))
					const label = text(m.action?.label, 40)
					setHubbyLiveNav(hubby, items.length || label || m.search ? {
						items,
						action: label ? { label, onClick: () => send({ type: 'nav-action' }) } : undefined,
						search: typeof m.search === 'string' ? text(m.search, 40) : undefined
					} : null)
					break
				}
				case 'served':
					served(m.id, m.ok, m.ok ? m.value : undefined, m.ok ? undefined : m.error)
					break
				case 'call': {
					const method = methods[m.method]
					try {
						if (!method) throw new Error(`unknown method ${m.method}`)
						send({ type: 'result', id: m.id, ok: true, value: await method(...m.args) })
					}
					catch (err) {
						const failure: CallError = err instanceof ApiError
							? { message: err.message, status: err.status, detail: err.detail }
							: { message: err instanceof Error ? err.message : String(err) }
						send({ type: 'result', id: m.id, ok: false, error: failure.message, failure })
					}
					break
				}
				case 'back-depth':
					setBackDepth(m.depth)
					break
				case 'navigate':
					if (!headless) navigate(`${base}${m.path === '/' ? '' : m.path}`)
					break
				case 'key':
					if (headless) break
					// the app's shortcuts (Ctrl+Alt reveal…) don't see keys typed in the frame: replayed here
					window.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, ctrlKey: m.ctrl, altKey: m.alt, shiftKey: m.shift, metaKey: m.meta }))
					break
			}
		}
		window.addEventListener('message', onMessage)
		return () => {
			window.removeEventListener('message', onMessage)
			stopServing?.()
			if (!headless) setHubbyLiveNav(hubby, null)
			following.forEach(stop => stop())
			following.clear()
			streams.forEach(controller => controller.abort())
			streams.clear()
			watching.forEach(stop => stop())
			watching.clear()
			playerOffs.forEach(stop => stop())
			setSurfaceStates({})
		}
	}, [hubby])

	if (headless) {
		return src ? <iframe key={build} ref={frame} title={`${hubby} (API)`} src={src} sandbox="allow-scripts" className="hidden" aria-hidden /> : null
	}
	if (!src) {
		return <div className="flex-1 flex items-center justify-center text-sm text-steel-400">This hubby runs isolated: not available on this platform yet.</div>
	}
	return (
		<div className="relative flex-1 min-h-0 flex bg-steel-900">
			<iframe
				key={build}
				ref={frame}
				title={hubby}
				src={src}
				// popups: its links open outside the app (the system's browser, the shell decides), as a
				// mail's links and attachments do
				sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
				// above a covered web surface (which goes under it), see-through where the frame is: its own
				// background is the frame document's (the container's below, same colour)
				className="relative z-[1] flex-1 min-h-0 w-full border-0 bg-transparent"
			/>
			{platform.capabilities.webview && (platform.nativeSurfaces
				? <NativeSurfaceViews surfaces={{ states: surfaceStates, elements: surfaceElements }} frame={frame} call={(path, options) => hubbyApi(hubby).api(path, options)} send={send} />
				: <SurfaceViews hubby={hubby} surfaces={{ states: surfaceStates, elements: surfaceElements }} call={(path, options) => hubbyApi(hubby).api(path, options)} send={send} />
			)}
		</div>
	)
}
