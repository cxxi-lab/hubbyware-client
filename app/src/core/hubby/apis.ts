import { validate, type Schema } from './schema'

/**
 * The hubbies' APIs (docs/plan-api-hubbies.md): what each installed hubby offers (its api.json,
 * read with its files), and the calls between them. A method runs in the offering hubby's frame —
 * the one open, else one started unseen (HubbyApiFrames), stopped after a while without a call.
 * The host checks the caller's scope (HubbyHost), the input and the result against the schemas.
 */

export interface ApiMethod {
	description: string
	input: Schema
	output: Schema
	/** read: free; write: the user's data changed (an agent's call confirmed); outward: outside Hubbyware or for good (always confirmed) */
	effect: 'read' | 'write' | 'outward'
	/** the interface it implements (callAll), if any */
	interface?: string
}

const apis = new Map<string, Record<string, ApiMethod>>()
// each hubby's api.md: how to use its API (an agent reads it)
const docs = new Map<string, string>()
// the hubbies that may answer: active, shown (not hidden by its Privacy), not locked
let available = new Set<string>()

/** Takes an installed hubby's api.json (and its api.md) into account. */
export function registerApi(hubby: string, api: { methods?: Record<string, ApiMethod> }, doc?: string | null): void {
	if (api.methods && typeof api.methods === 'object') apis.set(hubby, api.methods)
	if (doc) docs.set(hubby, doc.slice(0, 20_000))
}

/** Every API known here: by hubby, its methods and its api.md (an agent's catalogue: core/ai/agent.ts). */
export function allApis(): Array<{ hubby: string, methods: Record<string, ApiMethod>, doc: string | null }> {
	return [...apis].map(([hubby, methods]) => ({ hubby, methods, doc: docs.get(hubby) ?? null }))
}

/** The hubbies that may answer now (the app's layout says: active, shown; a lock only hides screens). */
export function setAvailableHubbies(ids: string[]): void {
	available = new Set(ids)
	// an unseen frame of a hubby gone (hidden again, disabled): stopped, its background work too
	let stopped = false
	for (const [hubby, timer] of headless) {
		if (!available.has(hubby)) { if (timer) clearTimeout(timer); headless.delete(hubby); stopped = true }
	}
	// back: its background work starts again
	for (const hubby of background) {
		if (available.has(hubby) && !headless.has(hubby)) { headless.set(hubby, null); stopped = true }
	}
	if (stopped) changed()
}

/** Whether the hubby may answer (and be opened from another one) now. */
export const isAvailable = (hubby: string): boolean => available.has(hubby)

/**
 * The interfaces the platform defines (their contract, whoever implements them): what is sent to
 * each hubby offering one and what each gives back are checked against it too, so the caller can
 * rely on it (the SDK's types: TimelineEntry).
 */
const ISO = '^\\d{4}-\\d{2}-\\d{2}T'
export const INTERFACES: Record<string, { input: Schema, output: Schema }> = {
	// dated items for a calendar (Planner): between start and end, ISO date-times
	'timeline.items': {
		input: { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string', pattern: ISO }, end: { type: 'string', pattern: ISO } } },
		output: {
			type: 'array',
			maxItems: 1000,
			items: {
				type: 'object',
				required: ['id', 'date', 'title', 'href'],
				properties: {
					id: { type: 'string', maxLength: 200 },
					date: { type: 'string', pattern: ISO },
					title: { type: 'string', maxLength: 500 },
					// a page of the hubby giving it (its path, a query allowed)
					href: { type: 'string', pattern: '^/' },
					color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }
				}
			}
		}
	}
}

/** The hubbies offering an interface, with the method that implements it. */
export function offering(iface: string): Array<{ hubby: string, method: string }> {
	const found: Array<{ hubby: string, method: string }> = []
	for (const [hubby, methods] of apis) {
		if (!available.has(hubby)) continue
		for (const [method, m] of Object.entries(methods)) {
			if (m.interface === iface) found.push({ hubby, method })
		}
	}
	return found
}

// --- the frames that answer ---

interface Server {
	serve: (id: number, method: string, input: unknown, from: string) => void
	headless: boolean
}

const servers = new Map<string, Set<Server>>()
const serverWaiters = new Map<string, Set<() => void>>()

/** A frame of the hubby, ready to answer (HubbyHost, once it said `ready`); returns its removal. */
export function serveFrom(hubby: string, server: Server): () => void {
	const set = servers.get(hubby) ?? new Set()
	servers.set(hubby, set)
	set.add(server)
	serverWaiters.get(hubby)?.forEach(w => w())
	serverWaiters.delete(hubby)
	return () => { set.delete(server) }
}

const pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
let nextId = 1

/** A frame's answer to a `serve`. */
export function served(id: number, ok: boolean, value: unknown, error?: string): void {
	const p = pending.get(id)
	if (!p) return
	pending.delete(id)
	clearTimeout(p.timer)
	if (ok) p.resolve(value)
	else p.reject(new Error(error ?? 'failed'))
}

// --- the frames started only to answer (unseen) ---

const IDLE_MS = 120_000
const START_MS = 20_000
const CALL_MS = 30_000

const headless = new Map<string, ReturnType<typeof setTimeout> | null>()
/** the hubbies working in the background: their unseen frame stays (no idle end) */
let background = new Set<string>()
let headlessIds: string[] = []
const headlessListeners = new Set<() => void>()
const changed = () => {
	headlessIds = [...headless.keys()]
	headlessListeners.forEach(l => l())
}

/** Keeps the hubby's unseen frame for IDLE_MS more (started if it isn't). */
function keepHeadless(hubby: string) {
	const had = headless.has(hubby)
	const timer = headless.get(hubby)
	if (timer) clearTimeout(timer)
	headless.set(hubby, background.has(hubby) ? null : setTimeout(() => { headless.delete(hubby); changed() }, IDLE_MS))
	if (!had) changed()
}

/**
 * The hubbies working in the background (docs/plan-auto-desktop.md D1): their unseen frame runs as
 * long as they are in the list; one leaving it goes back to answering its API only (then ends idle).
 */
export function setBackgroundHubbies(ids: string[]): void {
	const next = new Set(ids)
	const left = [...background].filter(id => !next.has(id))
	background = next
	for (const id of next) {
		if (!available.has(id)) continue
		const timer = headless.get(id)
		if (timer) clearTimeout(timer)
		headless.set(id, null)
	}
	// its frame, if it runs, ends once idle
	for (const id of left) if (headless.has(id)) keepHeadless(id)
	changed()
}

async function frameOf(hubby: string): Promise<Server> {
	const pick = () => {
		const all = [...(servers.get(hubby) ?? [])]
		return all.find(s => !s.headless) ?? all[0]
	}
	const ready = pick()
	if (ready) {
		if (ready.headless) keepHeadless(hubby)
		return ready
	}
	keepHeadless(hubby)
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			serverWaiters.get(hubby)?.delete(done)
			reject(new Error(`${hubby} did not start`))
		}, START_MS)
		const done = () => { clearTimeout(timer); resolve() }
		const set = serverWaiters.get(hubby) ?? new Set()
		serverWaiters.set(hubby, set)
		set.add(done)
	})
	return pick()!
}

/** A method of a named hubby, for `caller` (its scope already checked). */
export async function callHubby(caller: string, hubby: string, method: string, input: unknown): Promise<unknown> {
	if (!available.has(hubby)) throw new Error(`${hubby} is not available`)
	const methods = apis.get(hubby)
	const m = methods && Object.hasOwn(methods, method) ? methods[method] : undefined
	if (!m) throw new Error(`${hubby} offers no method ${method}`)
	const invalid = validate(m.input, input)
	if (invalid) throw new Error(`invalid input for ${hubby} ${method}: ${invalid}`)
	const server = await frameOf(hubby)
	const id = nextId++
	const value = await new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${hubby} ${method}: no answer`)) }, CALL_MS)
		pending.set(id, { resolve, reject, timer })
		server.serve(id, method, input, caller)
	})
	const wrong = validate(m.output, value)
	if (wrong) throw new Error(`${hubby} ${method} gave an invalid result: ${wrong}`)
	return value
}

/** Every hubby offering the interface: what each gave, or why it failed. */
export async function callAll(caller: string, iface: string, input: unknown): Promise<Array<{ hubby: string, result?: unknown, error?: string }>> {
	const contract = Object.hasOwn(INTERFACES, iface) ? INTERFACES[iface] : undefined
	const invalid = contract && validate(contract.input, input)
	if (invalid) throw new Error(`invalid input for ${iface}: ${invalid}`)
	return Promise.all(offering(iface).map(({ hubby, method }) => callHubby(caller, hubby, method, input).then(
		result => {
			const wrong = contract && validate(contract.output, result)
			if (wrong) throw new Error(`${hubby} gave an invalid ${iface}: ${wrong}`)
			return { hubby, result }
		}
	).then(
		answer => answer,
		(err: unknown) => ({ hubby, error: err instanceof Error ? err.message : String(err) })
	)))
}

/** The hubbies whose unseen frame runs (HubbyApiFrames), and their changes. */
export const headlessFrames = {
	subscribe(listener: () => void): () => void {
		headlessListeners.add(listener)
		return () => { headlessListeners.delete(listener) }
	},
	current: (): string[] => headlessIds,
	/** the frame is the hubby's background one (it runs its `background` work) */
	isBackground: (hubby: string): boolean => background.has(hubby)
}
