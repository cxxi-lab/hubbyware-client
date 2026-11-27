import { CapacitorHttp, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type {
	AiChatOutcome, AiChatRequest, AiChatResult, AiImageResult, AiImportedFile, AiImportKind, AiOutcome, AiSpeechResult,
	InstalledModel, LocalAiApi, LocalModelsApi, LocalModelsState, ModelFit, ModelPlan, RepoListing, RepoModel, UserModel
} from './types'

/**
 * The local AI on Android (client docs/plan-ia-android.md, phase 2): the desktop's main/ai/models.ts,
 * chat.ts and speech.ts, in the app — the native side (LocalAiPlugin.java) only has the device, the
 * files and the engine. The models the hubbies declare are read from the copies the native store
 * checked at install (HubbyStore, never a frame's word); downloaded straight from huggingface.co,
 * resumed, their sha256 checked as they come, kept once by sha256 in the app's own storage; used
 * only once the user agreed on this device. A phone runs text and voice models (no image, no vision:
 * the measures of § 2), on its CPU, one at a time.
 */

type Family = 'text' | 'image' | 'voice' | 'embed'
interface ModelFile { path: string, sha256: string, size: number }
interface ModelVariant { repo: string, revision: string, files: ModelFile[], requires?: { vram?: number, ram?: number } }
interface ModelDeclaration { family: Family, description?: string, variants: ModelVariant[] }
interface DeviceInfo { ramMib: number, freeDiskMib: number, directory: string, text: boolean, voice: boolean }

interface StoredFile { repo: string, revision: string, path: string, size: number, file: string, users: string[] }
interface StoredImport { kind: 'audio', name: string, size: number, seconds: number | null, file: string, users: string[] }
interface Index { files: Record<string, StoredFile>, consents: Record<string, string>, userModels: Record<string, UserModel[]>, imports: Record<string, StoredImport> }

interface Native {
	device(): Promise<DeviceInfo>
	readIndex(): Promise<{ json: string | null }>
	writeIndex(o: { json: string }): Promise<void>
	sizes(o: { paths: string[] }): Promise<{ sizes: number[] }>
	download(o: { id: number, repo: string, revision: string, path: string, sha256: string, size: number }): Promise<{ file: string }>
	remove(o: { sha256: string }): Promise<void>
	chat(o: { id: number, spec: Spec, path: string, body: string }): Promise<{ status: number, error?: string }>
	request(o: { id: number, spec: Spec, path: string, body: string }): Promise<{ status: number, body: string }>
	abort(o: { id: number }): Promise<void>
	importAudio(): Promise<{ cancelled?: boolean, sha256?: string, name?: string, size?: number, file?: string }>
	forgetImport(o: { sha256: string }): Promise<void>
	readFile(o: { path: string }): Promise<{ data: string }>
	addListener(event: 'download', cb: (e: { id: number, received: number }) => void): Promise<PluginListenerHandle>
	addListener(event: 'chat', cb: (e: { id: number, line: string }) => void): Promise<PluginListenerHandle>
}
interface Spec { engine: 'text' | 'voice', args: string[] }

const LocalAi = registerPlugin<Native>('LocalAi')
const Hubbies = registerPlugin<{ getState(): Promise<{ hubbies: Array<{ id: string, label?: string, ai?: unknown }> }> }>('Modules')

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const PATH = /^(?!.*\.\.)[A-Za-z0-9._-]{1,120}(\/[A-Za-z0-9._-]{1,120}){0,3}$/
const MIB = 2 ** 20
/** disk kept free besides a model */
const DISK_MARGIN_MIB = 2_048
/** below this much RAM, a phone runs no model (the measures: a 4 B model and the app in 7 GB) */
const PHONE_MIN_RAM_MIB = 5_500

// --- the index (installed files, consents, models added by link, imports) ---

let indexCache: Index | null = null

async function readIndex(): Promise<Index> {
	if (indexCache) return indexCache
	const { json } = await LocalAi.readIndex()
	let raw: Partial<Index> = {}
	try { raw = json ? JSON.parse(json) as Partial<Index> : {} }
	catch { /* a broken index: started again (the files stay, found again by their sha256 on download) */ }
	indexCache = { files: raw.files ?? {}, consents: raw.consents ?? {}, userModels: raw.userModels ?? {}, imports: raw.imports ?? {} }
	return indexCache
}

async function writeIndex(index: Index): Promise<void> {
	indexCache = index
	await LocalAi.writeIndex({ json: JSON.stringify(index) })
}

/** Index edits one after the other (two downloads finishing together never lose one). */
let editing: Promise<unknown> = Promise.resolve()
function editIndex<T>(edit: (index: Index) => T | Promise<T>): Promise<T> {
	const next = editing.then(async () => {
		const index = await readIndex()
		const out = await edit(index)
		await writeIndex(index)
		return out
	})
	editing = next.catch(() => {})
	return next
}

// --- events ---

const changeListeners = new Set<() => void>()
const failureListeners = new Set<(f: { hubby: string, name: string, error: string }) => void>()
let lastChange = 0
function changed(throttle = false): void {
	if (throttle && Date.now() - lastChange < 500) return
	lastChange = Date.now()
	changeListeners.forEach(l => l())
}

// --- declarations and fit ---

function validDeclaration(model: unknown): { model: ModelDeclaration } | { error: string } {
	const m = model as Partial<ModelDeclaration> | null
	if (!m || typeof m !== 'object' || !['text', 'image', 'voice', 'embed'].includes(m.family as string)) return { error: 'no family' }
	if (!Array.isArray(m.variants) || m.variants.length === 0) return { error: 'no variant' }
	for (const v of m.variants) {
		if (!v || !REPO.test(v.repo ?? '') || !COMMIT.test(v.revision ?? '')) return { error: 'a variant is not pinned to a commit' }
		if (!Array.isArray(v.files) || v.files.length === 0) return { error: 'a variant has no file' }
		for (const f of v.files) {
			if (!f || !PATH.test(f.path ?? '') || !SHA256.test(f.sha256 ?? '') || !Number.isInteger(f.size) || f.size <= 0) return { error: 'a file is not pinned (path, sha256, size)' }
		}
	}
	return { model: m as ModelDeclaration }
}

/**
 * How a variant fits this phone: the platform's rules (plan § 3.2) — text and voice on the CPU (slow:
 * no GPU here) with enough RAM; images and vision (a projector beside a text model) refused.
 */
function fitOf(family: Family, variant: ModelVariant, device: DeviceInfo, installed: boolean): { fit: ModelFit, reason: string } {
	if (family === 'image') return { fit: 'cannot', reason: 'images are too slow on this device' }
	// image vectors (CLIP) run on a desktop's GPU only (docs/plan-discover-scan.md D4)
	if (family === 'embed') return { fit: 'cannot', reason: 'image vectors run on a desktop only' }
	if (variant.files.some(f => /mmproj/i.test(f.path))) return { fit: 'cannot', reason: 'seeing images is too slow on this device' }
	if (!device[family]) return { fit: 'cannot', reason: 'no AI engine for this device' }
	if (device.ramMib < PHONE_MIN_RAM_MIB) return { fit: 'cannot', reason: `needs a device with ${Math.ceil(PHONE_MIN_RAM_MIB / 1024)} GB of RAM` }
	const sizeMib = variant.files.reduce((n, f) => n + f.size, 0) / MIB
	if (!installed && device.freeDiskMib < sizeMib + DISK_MARGIN_MIB) return { fit: 'cannot', reason: `needs ${Math.ceil(sizeMib / 1024)} GB of storage, ${Math.floor(device.freeDiskMib / 1024)} GB free` }
	const ram = variant.requires?.ram ?? Math.ceil(sizeMib * 1.2)
	if (device.ramMib < ram) return { fit: 'cannot', reason: `needs ${ram} MiB of RAM, this device has ${device.ramMib}` }
	return { fit: 'slow', reason: 'on the CPU (a phone: slower)' }
}

const key = (hubby: string, name: string): string => `${hubby}/${name}`
const variantKey = (v: { repo: string, revision: string }): string => `${v.repo}@${v.revision}`
const asDeclaration = (m: UserModel): ModelDeclaration => ({ family: 'text', description: m.label, variants: [{ repo: m.repo, revision: m.revision, files: m.files, requires: m.requires }] })

async function hubbyDeclarations(): Promise<Array<{ id: string, label: string, ai?: unknown }>> {
	const { hubbies } = await Hubbies.getState()
	return hubbies.map(h => ({ id: h.id, label: typeof h.label === 'string' ? h.label : h.id, ai: h.ai }))
}

function declarationsOf(hubby: { id: string, ai?: unknown }, index: Index): Array<[string, unknown, boolean]> {
	const declared = hubby.ai && typeof hubby.ai === 'object' ? Object.entries(hubby.ai as Record<string, unknown>).map(([n, d]) => [n, d, false] as [string, unknown, boolean]) : []
	return [...declared, ...(index.userModels[hubby.id] ?? []).map(m => [m.name, asDeclaration(m), true] as [string, unknown, boolean])]
}

/** The files present (their stored copy has its size). */
async function presentSet(index: Index): Promise<Set<string>> {
	const entries = Object.entries(index.files)
	if (!entries.length) return new Set()
	const { sizes } = await LocalAi.sizes({ paths: entries.map(([, s]) => s.file) })
	return new Set(entries.filter(([, s], i) => sizes[i] === s.size).map(([sha]) => sha))
}

const downloads = new Map<string, { received: number, total: number, done: Promise<void> }>()

async function modelPlans(): Promise<ModelPlan[]> {
	const [device, index, hubbies] = await Promise.all([LocalAi.device(), readIndex(), hubbyDeclarations()])
	const present = await presentSet(index)
	const plans: ModelPlan[] = []
	for (const hubby of hubbies) {
		for (const [name, raw, byLink] of declarationsOf(hubby, index)) {
			if (!NAME.test(name)) continue
			const checked = validDeclaration(raw)
			if ('error' in checked) {
				plans.push({ hubby: hubby.id, hubbyLabel: hubby.label, name, family: (raw as { family?: Family }).family ?? 'text', description: null, variants: [], chosen: null, consented: false, installed: false, download: null, invalid: checked.error })
				continue
			}
			const model = checked.model
			const variants = model.variants.map(v => {
				const installed = v.files.every(f => present.has(f.sha256))
				return { repo: v.repo, revision: v.revision, sizeBytes: v.files.reduce((n, f) => n + f.size, 0), installed, ...fitOf(model.family, v, device, installed) }
			})
			// a phone: the smallest that fits (the hubby's order puts the big ones first, for a PC)
			const fitting = variants.map((v, i) => ({ v, i })).filter(({ v }) => v.fit !== 'cannot')
			const pick = fitting.find(({ v }) => v.installed) ?? fitting.sort((a, b) => b.v.sizeBytes - a.v.sizeBytes)[0]
			const chosen = pick ? pick.i : -1
			const chosenVariant = chosen >= 0 ? model.variants[chosen] : null
			const dl = chosenVariant ? downloads.get(variantKey(chosenVariant)) : undefined
			plans.push({
				hubby: hubby.id, hubbyLabel: hubby.label, name, family: model.family, description: model.description ?? null, variants,
				chosen: chosen >= 0 ? chosen : null,
				consented: !!chosenVariant && index.consents[key(hubby.id, name)] === variantKey(chosenVariant),
				installed: chosen >= 0 && variants[chosen].installed,
				download: dl ? { received: dl.received, total: dl.total } : null,
				invalid: null,
				byLink
			})
		}
	}
	return plans
}

async function declaration(hubby: string, name: string): Promise<ModelDeclaration> {
	const [hubbies, index] = await Promise.all([hubbyDeclarations(), readIndex()])
	const found = hubbies.find(h => h.id === hubby)
	const raw = found ? declarationsOf(found, index).find(([n]) => n === name)?.[1] : undefined
	const checked = validDeclaration(raw)
	if ('error' in checked) throw new Error(`${hubby} declares no model ${name} this device accepts`)
	return checked.model
}

let nextDownload = 1

async function downloadModel(hubby: string, name: string): Promise<void> {
	const model = await declaration(hubby, name)
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === name)
	if (!plan || plan.chosen === null) throw new Error(`${hubby} ${name}: no variant can run on this device`)
	const variant = model.variants[plan.chosen]
	await editIndex(index => { index.consents[key(hubby, name)] = variantKey(variant) })
	const k = variantKey(variant)
	const running = downloads.get(k)
	if (running) return running.done
	const state = { received: 0, total: variant.files.reduce((n, f) => n + f.size, 0), done: Promise.resolve() }
	state.done = (async () => {
		try {
			let before = 0
			for (const f of variant.files) {
				const present = await presentSet(await readIndex())
				if (present.has(f.sha256)) { before += f.size; state.received = before; continue }
				const id = nextDownload++
				const handle = await LocalAi.addListener('download', e => {
					if (e.id !== id) return
					state.received = before + e.received
					changed(true)
				})
				try {
					const { file } = await LocalAi.download({ id, repo: variant.repo, revision: variant.revision, path: f.path, sha256: f.sha256, size: f.size })
					await editIndex(index => {
						index.files[f.sha256] = { repo: variant.repo, revision: variant.revision, path: f.path, size: f.size, file, users: [...new Set([...(index.files[f.sha256]?.users ?? []), key(hubby, name)])] }
					})
				}
				finally {
					void handle.remove()
				}
				before += f.size
				state.received = before
			}
			await editIndex(index => {
				for (const f of variant.files) {
					const s = index.files[f.sha256]
					if (s && !s.users.includes(key(hubby, name))) s.users.push(key(hubby, name))
				}
			})
		}
		catch (err) {
			failureListeners.forEach(l => l({ hubby, name, error: err instanceof Error ? err.message : String(err) }))
			throw err
		}
		finally {
			downloads.delete(k)
			changed()
		}
	})()
	downloads.set(k, state)
	changed()
	return state.done
}

/** The files of the hubby's model on this device, if the user agreed and they are here. */
async function modelFiles(hubby: string, name: string): Promise<string[] | null> {
	const model = await declaration(hubby, name)
	const index = await readIndex()
	const variant = model.variants.find(v => variantKey(v) === index.consents[key(hubby, name)])
	if (!variant) return null
	const present = await presentSet(index)
	if (!variant.files.every(f => present.has(f.sha256))) return null
	return variant.files.map(f => index.files[f.sha256].file)
}

async function installedModels(): Promise<InstalledModel[]> {
	const index = await readIndex()
	const present = await presentSet(index)
	return Object.entries(index.files).filter(([sha]) => present.has(sha))
		.map(([sha256, s]) => ({ sha256, repo: s.repo, revision: s.revision, path: s.path, sizeBytes: s.size, users: s.users }))
}

// --- models added by link (desktop: inspectRepo, setUserModels) ---

const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i

function parseLink(link: string): { repo: string, ref: string, path: string | null } {
	const text = link.trim().replace(/^https?:\/\/(www\.)?huggingface\.co\//, '').replace(/[?#].*$/, '').replace(/\/$/, '')
	const [owner, name, kind, ref, ...rest] = text.split('/')
	const repo = `${owner}/${name}`
	if (!REPO.test(repo)) throw new Error('not a Hugging Face model: give its address (huggingface.co/<owner>/<name>) or owner/name')
	if (kind && !['blob', 'resolve', 'tree'].includes(kind)) throw new Error('not a model\'s address on Hugging Face')
	return { repo, ref: ref ? decodeURIComponent(ref) : 'main', path: rest.length ? rest.map(decodeURIComponent).join('/') : null }
}

/** Hugging Face's API, by the native HTTP client (no CORS for the WebView's fetch). */
async function hf<T>(path: string): Promise<T> {
	const res = await CapacitorHttp.get({ url: `https://huggingface.co/api/models/${path}`, responseType: 'json' })
	if (res.status === 401 || res.status === 403) throw new Error('this repo is gated or private: only public repos for now')
	if (res.status < 200 || res.status >= 300) throw new Error(`Hugging Face answered ${res.status}`)
	return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T
}

function estimate(sizeBytes: number): { vram: number, ram: number } {
	const mib = sizeBytes / MIB
	return { vram: Math.ceil(mib + 1_300), ram: Math.ceil(mib * 1.1 + 1_500) }
}

async function inspectRepo(link: string): Promise<RepoListing> {
	const { repo, ref, path: wanted } = parseLink(link)
	const commit = COMMIT.test(ref) ? ref : (await hf<{ sha: string }>(`${repo}/revision/${encodeURIComponent(ref)}`)).sha
	if (!COMMIT.test(commit ?? '')) throw new Error('its revision was not found')
	const tree = await hf<Array<{ type: string, path: string, lfs?: { oid: string, size: number } }>>(`${repo}/tree/${commit}?recursive=true`)
	const groups = new Map<string, ModelFile[]>()
	for (const f of tree) {
		if (f.type !== 'file' || !/\.gguf$/i.test(f.path) || /mmproj/i.test(f.path) || !PATH.test(f.path)) continue
		if (!f.lfs || !SHA256.test(f.lfs.oid)) continue
		const group = f.path.replace(SPLIT, '')
		groups.set(group, [...(groups.get(group) ?? []), { path: f.path, sha256: f.lfs.oid, size: f.lfs.size }])
	}
	const device = await LocalAi.device()
	const models: RepoModel[] = [...groups.entries()].map(([group, files]) => {
		files.sort((a, b) => a.path.localeCompare(b.path))
		const sizeBytes = files.reduce((n, f) => n + f.size, 0)
		const requires = estimate(sizeBytes)
		return { name: `u-${files[0].sha256.slice(0, 12)}`, label: (group.split('/').pop() ?? group).replace(/\.gguf$/i, ''), files, sizeBytes, requires, ...fitOf('text', { repo, revision: commit, files, requires }, device, false) }
	}).sort((a, b) => a.sizeBytes - b.sizeBytes)
	if (!models.length) throw new Error('no GGUF model in this repo (the engine runs GGUF files)')
	const selected = wanted ? models.find(m => m.files.some(f => f.path === wanted))?.name ?? null : null
	return { repo, revision: commit, models, selected }
}

async function setUserModels(hubby: string, list: unknown): Promise<number> {
	if (!Array.isArray(list) || list.length > 50) throw new Error('at most 50 models')
	const models: UserModel[] = []
	for (const m of list as Partial<UserModel>[]) {
		const files = Array.isArray(m?.files) ? m.files : []
		const ok = m && typeof m.name === 'string' && /^u-[0-9a-f]{12}$/.test(m.name) && typeof m.label === 'string' && REPO.test(m.repo ?? '') && COMMIT.test(m.revision ?? '')
			&& files.length > 0 && files.every(f => PATH.test(f?.path ?? '') && SHA256.test(f?.sha256 ?? '') && Number.isInteger(f?.size) && f.size > 0)
			&& Number.isInteger(m.requires?.vram) && Number.isInteger(m.requires?.ram)
		if (!ok) throw new Error('a model added by link is not pinned (repo, commit, files with sha256 and size)')
		models.push({ name: m.name!, label: m.label!.slice(0, 120), repo: m.repo!, revision: m.revision!, files: files.map(f => ({ path: f.path, sha256: f.sha256, size: f.size })), requires: { vram: m.requires!.vram, ram: m.requires!.ram } })
	}
	await editIndex(index => { index.userModels[hubby] = models })
	changed()
	return models.length
}

// --- ai.chat (desktop: main/ai/chat.ts) ---

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const MAX_MESSAGES = 400
const MAX_CHARS = 400_000
const MAX_TOOLS = 64
const MAX_TOKENS = 8_192
const TEMPLATES = ['chatml', 'llama3', 'mistral-v7', 'gemma', 'phi3', 'vicuna', 'zephyr', 'deepseek3']
/** a phone's context: the model's and the app's memory in 7 GB */
const PHONE_CONTEXT = 4_096

const invalid = (message: string): AiChatOutcome => ({ ok: false, code: 'invalid', message })

function checked(request: unknown): { body: Record<string, unknown>, model: string, template: string | null } | AiChatOutcome {
	const r = request as Partial<AiChatRequest> | null
	if (!r || typeof r !== 'object' || typeof r.model !== 'string' || !NAME.test(r.model)) return invalid('model: a model it declares, by name')
	if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > MAX_MESSAGES) return invalid(`messages: 1 to ${MAX_MESSAGES}`)
	let chars = 0
	const messages = []
	for (const m of r.messages) {
		if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') return invalid('a message is { role: system|user|assistant|tool, content: string }')
		if (m.images !== undefined) return invalid('images: this device doesn\'t see images')
		chars += m.content.length
		const out: Record<string, unknown> = { role: m.role, content: m.content }
		if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
			out.tool_calls = (m.tool_calls as Array<{ id?: unknown, function?: { name?: unknown, arguments?: unknown } }>).map(c => ({ id: String(c?.id ?? ''), type: 'function', function: { name: String(c?.function?.name ?? ''), arguments: String(c?.function?.arguments ?? '{}') } }))
		}
		if (m.role === 'tool') {
			if (typeof m.tool_call_id !== 'string') return invalid('a tool message names the call it answers (tool_call_id)')
			out.tool_call_id = m.tool_call_id
		}
		messages.push(out)
	}
	if (chars > MAX_CHARS) return invalid(`messages: at most ${MAX_CHARS} characters`)
	const body: Record<string, unknown> = {
		messages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: Math.min(Number.isInteger(r.maxTokens) && r.maxTokens! > 0 ? r.maxTokens! : 1_024, MAX_TOKENS),
		chat_template_kwargs: { enable_thinking: r.reasoning === true }
	}
	if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2) body.temperature = r.temperature
	const range = (v: unknown, min: number, max: number) => typeof v === 'number' && v >= min && v <= max
	if (range(r.topP, 0, 1)) body.top_p = r.topP
	if (range(r.minP, 0, 1)) body.min_p = r.minP
	if (range(r.repeatPenalty, 0.5, 2)) body.repeat_penalty = r.repeatPenalty
	if (Number.isInteger(r.repeatLastN) && range(r.repeatLastN, -1, 8192)) body.repeat_last_n = r.repeatLastN
	if (range(r.presencePenalty, -2, 2)) body.presence_penalty = r.presencePenalty
	if (r.stop !== undefined) {
		if (!Array.isArray(r.stop) || r.stop.length > 8 || r.stop.some(s => typeof s !== 'string' || !s || s.length > 64)) return invalid('stop: at most 8 strings')
		body.stop = r.stop
	}
	if (r.template !== undefined && !TEMPLATES.includes(String(r.template))) return invalid(`template: one of ${TEMPLATES.join(', ')}`)
	if (r.tools !== undefined) {
		if (!Array.isArray(r.tools) || r.tools.length > MAX_TOOLS) return invalid(`tools: at most ${MAX_TOOLS}`)
		for (const t of r.tools) {
			if (t?.type !== 'function' || typeof t.function?.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.function.name)) return invalid('a tool is { type: function, function: { name, description?, parameters? } }')
		}
		if (r.tools.length) body.tools = r.tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? { type: 'object', properties: {} } } }))
	}
	return { body, model: r.model, template: r.template ? String(r.template) : null }
}

/** The text engine on a model: the whole model read into memory (`--load-mode none`; a mapped one is read again and again on a phone: phase 1). */
function textSpec(model: string, template: string | null): Spec {
	return { engine: 'text', args: ['-m', model, '-c', String(PHONE_CONTEXT), '--jinja', '--load-mode', 'none', ...(template ? ['--chat-template', template] : [])] }
}

interface Chunk {
	choices?: Array<{ delta?: { content?: string | null, reasoning_content?: string | null, tool_calls?: Array<{ index: number, id?: string, function?: { name?: string, arguments?: string } }> }, finish_reason?: string | null }>
	usage?: { prompt_tokens: number, completion_tokens: number }
	timings?: { predicted_per_second?: number }
}

const chatListeners = new Set<(event: { id: number, kind: 'delta' | 'reasoning', text: string }) => void>()

async function chat(id: number, hubby: string, request: AiChatRequest): Promise<AiChatOutcome> {
	const req = checked(request)
	if ('ok' in req) return req
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === req.model)
	if (!plan || plan.invalid) return invalid(`${hubby} declares no model ${req.model} this device accepts`)
	if (plan.family !== 'text') return invalid(`${req.model} is not a text model`)
	if (plan.chosen === null) return { ok: false, code: 'unavailable', message: `${req.model} can't run on this device (${plan.variants.map(v => v.reason).filter(Boolean)[0] ?? 'too large'})` }
	if (!plan.consented) return { ok: false, code: 'consent', message: `${req.model} is not allowed on this device yet` }
	const files = await modelFiles(hubby, req.model)
	if (!files) return { ok: false, code: 'missing', message: `${req.model} is not downloaded yet` }

	let content = ''
	let finishReason: string | null = null
	let usage: AiChatResult['usage'] = null
	let tokensPerSecond: number | undefined
	const calls = new Map<number, { id: string, name: string, args: string }>()
	const handle = await LocalAi.addListener('chat', e => {
		if (e.id !== id || !e.line.startsWith('data:')) return
		const data = e.line.slice(5).trim()
		if (data === '[DONE]') return
		let c: Chunk
		try { c = JSON.parse(data) as Chunk }
		catch { return }
		if (c.usage) usage = { promptTokens: c.usage.prompt_tokens, completionTokens: c.usage.completion_tokens }
		if (c.timings?.predicted_per_second) tokensPerSecond = Math.round(c.timings.predicted_per_second * 10) / 10
		for (const choice of c.choices ?? []) {
			const d = choice.delta
			if (d?.content) { content += d.content; chatListeners.forEach(l => l({ id, kind: 'delta', text: d.content! })) }
			if (d?.reasoning_content) chatListeners.forEach(l => l({ id, kind: 'reasoning', text: d.reasoning_content! }))
			for (const t of d?.tool_calls ?? []) {
				const call = calls.get(t.index) ?? { id: '', name: '', args: '' }
				if (t.id) call.id = t.id
				if (t.function?.name) call.name += t.function.name
				if (t.function?.arguments) call.args += t.function.arguments
				calls.set(t.index, call)
			}
			if (choice.finish_reason) finishReason = choice.finish_reason
		}
	})
	try {
		const out = await LocalAi.chat({ id, spec: textSpec(files[0], req.template), path: '/v1/chat/completions', body: JSON.stringify(req.body) })
		if (out.status >= 400) return { ok: false, code: 'failed', message: `the engine answered ${out.status}: ${(out.error ?? '').slice(0, 300)}` }
		const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => {
			try { return { id: c.id, name: c.name, arguments: c.args ? JSON.parse(c.args) as unknown : {} } }
			catch { return { id: c.id, name: c.name, arguments: c.args as unknown, error: 'its arguments are not valid JSON' } }
		})
		const u = usage as AiChatResult['usage']
		return { ok: true, result: { content, toolCalls, finishReason, usage: u && tokensPerSecond ? { ...u, tokensPerSecond } : u } }
	}
	catch (err) {
		return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
	}
	finally {
		void handle.remove()
	}
}

// --- ai.speech (desktop: main/ai/speech.ts) ---

const LANGUAGES = ['auto', 'French', 'English', 'German', 'Spanish', 'Italian', 'Portuguese', 'Russian', 'Chinese', 'Japanese', 'Korean']
/** the voices registered on the running server (they live in its memory) */
const registered = new Set<string>()
let registeredSpec = ''

function wavSeconds(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.length < 44) return 0
	const byteRate = view.getUint32(28, true)
	let at = 12
	while (at + 8 <= bytes.length) {
		const size = view.getUint32(at + 4, true)
		const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
		if (tag === 'data') return byteRate ? Math.min(size, bytes.length - at - 8) / byteRate : 0
		at += 8 + size + (size % 2)
	}
	return 0
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0))
const failed = <T>(message: string): AiOutcome<T> => ({ ok: false, code: 'failed', message })

async function speech(id: number, hubby: string, request: unknown): Promise<AiOutcome<AiSpeechResult>> {
	const r = request as { model?: unknown, sample?: unknown, transcript?: unknown, text?: unknown, seed?: unknown, temperature?: unknown, language?: unknown } | null
	const bad = (message: string): AiOutcome<AiSpeechResult> => ({ ok: false, code: 'invalid', message })
	if (!r || typeof r !== 'object' || typeof r.model !== 'string' || !NAME.test(r.model) || typeof r.sample !== 'string' || typeof r.text !== 'string' || !r.text.trim()) return bad('ai.speech({ model, sample, transcript, text, … })')
	if (r.text.length > 3_000) return bad('text: at most 3 000 characters')
	if (typeof r.transcript !== 'string' || !r.transcript.trim() || r.transcript.length > 2_000) return bad('transcript: what the sample says (at most 2 000 characters)')
	if (r.language !== undefined && !LANGUAGES.includes(String(r.language))) return bad(`language: one of ${LANGUAGES.join(', ')}`)
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === r.model)
	if (!plan || plan.invalid) return bad(`${hubby} declares no model ${r.model} this device accepts`)
	if (plan.family !== 'voice') return bad(`${r.model} is not a voice model`)
	if (plan.chosen === null) return { ok: false, code: 'unavailable', message: `${r.model} can't run on this device` }
	if (!plan.consented) return { ok: false, code: 'consent', message: `${r.model} is not allowed on this device yet` }
	const files = await modelFiles(hubby, r.model)
	if (!files) return { ok: false, code: 'missing', message: `${r.model} is not downloaded yet` }
	const codec = files.find(f => /tokenizer|codec/i.test(f.split('/').pop() ?? ''))
	const talker = files.find(f => f !== codec)
	if (!codec || !talker) return bad(`${r.model}: a voice model has a talker and a codec (its tokenizer)`)
	const index = await readIndex()
	const sample = index.imports[r.sample]
	if (!sample || !sample.users.includes(hubby)) return bad('sample: a file this hubby imported')
	const spec: Spec = { engine: 'voice', args: ['--model', talker, '--codec', codec] }
	const specKey = spec.args.join('\n')
	try {
		if (registeredSpec !== specKey) { registered.clear(); registeredSpec = specKey }
		const voice = `v${r.sample.slice(0, 24)}`
		const voiceKey = `${voice}\n${r.transcript}`
		if (!registered.has(voiceKey)) {
			const { data } = await LocalAi.readFile({ path: sample.file })
			const out = await LocalAi.request({ id, spec, path: '/v1/audio/voices', body: JSON.stringify({ name: voice, ref_text: r.transcript, wav_b64: data }) })
			// a fresh server (the AI process was replaced): its voices start empty — registered again
			if (out.status >= 400) return failed(`the voice server refused the sample (${out.status}): ${new TextDecoder().decode(fromBase64(out.body)).slice(0, 200)}`)
			registered.add(voiceKey)
		}
		const body: Record<string, unknown> = { input: r.text, voice, response_format: 'wav' }
		if (Number.isInteger(r.seed) && (r.seed as number) >= 0) body.seed = r.seed
		if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2) body.temperature = r.temperature
		if (r.language && r.language !== 'auto') body.language = r.language
		let out = await LocalAi.request({ id, spec, path: '/v1/audio/speech', body: JSON.stringify(body) })
		if (out.status === 400 || out.status === 404) {
			// the voice unknown: the server was restarted since (another model ran) — registered again, once
			registered.clear()
			const { data } = await LocalAi.readFile({ path: sample.file })
			await LocalAi.request({ id, spec, path: '/v1/audio/voices', body: JSON.stringify({ name: voice, ref_text: r.transcript, wav_b64: data }) })
			registered.add(voiceKey)
			out = await LocalAi.request({ id, spec, path: '/v1/audio/speech', body: JSON.stringify(body) })
		}
		if (out.status >= 400) return failed(`the voice server answered ${out.status}: ${new TextDecoder().decode(fromBase64(out.body)).slice(0, 200)}`)
		const wav = fromBase64(out.body)
		return { ok: true, result: { audio: `data:audio/wav;base64,${out.body}`, seconds: Math.round(wavSeconds(wav) * 10) / 10 } }
	}
	catch (err) {
		return failed(err instanceof Error ? err.message : String(err))
	}
}

// --- files imported for a hubby (desktop: main/ai/imports.ts): voice samples on a phone ---

async function importFile(hubby: string, kind: AiImportKind): Promise<AiImportedFile | null> {
	if (kind !== 'audio') throw new Error('image models are not used on this device')
	const picked = await LocalAi.importAudio()
	if (picked.cancelled || !picked.sha256 || !picked.file) return null
	const { data } = await LocalAi.readFile({ path: picked.file })
	const bytes = fromBase64(data)
	if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WAVE') {
		await LocalAi.forgetImport({ sha256: picked.sha256 })
		throw new Error('a voice sample is a WAV file')
	}
	const seconds = Math.round(wavSeconds(bytes) * 10) / 10
	const sha = picked.sha256
	const stored = await editIndex(index => {
		const before = index.imports[sha]
		index.imports[sha] = { kind: 'audio', name: picked.name ?? 'sample.wav', size: picked.size ?? bytes.length, seconds, file: picked.file!, users: [...new Set([...(before?.users ?? []), hubby])] }
		return index.imports[sha]
	})
	return toImported(sha, stored)
}

const toImported = (sha256: string, s: StoredImport): AiImportedFile => ({ sha256, kind: s.kind, name: s.name, size: s.size, family: null, seconds: s.seconds, users: s.users })

async function importedFiles(hubby: string | null): Promise<AiImportedFile[]> {
	const index = await readIndex()
	return Object.entries(index.imports).filter(([, s]) => hubby === null || s.users.includes(hubby)).map(([sha, s]) => toImported(sha, s))
}

async function forgetFile(sha256: string): Promise<void> {
	if (!SHA256.test(sha256)) throw new Error('invalid file')
	await editIndex(index => { delete index.imports[sha256] })
	await LocalAi.forgetImport({ sha256 })
}

// --- the platform's APIs ---

/** Only on an arm64 phone with the engine pinned (else null: no AI models on this device). */
export function createLocalModels(): LocalModelsApi {
	return {
		async state(): Promise<LocalModelsState> {
			const [device, plans, installed] = await Promise.all([LocalAi.device(), modelPlans(), installedModels()])
			return { device: { ramMib: device.ramMib, gpu: null, freeDiskMib: device.freeDiskMib, directory: device.directory }, plans, installed }
		},
		download: downloadModel,
		async remove(sha256) {
			if (!SHA256.test(sha256)) throw new Error('invalid model')
			await LocalAi.remove({ sha256 })
			await editIndex(index => {
				const stored = index.files[sha256]
				if (!stored) return
				delete index.files[sha256]
				for (const [k, v] of Object.entries(index.consents)) if (v === variantKey(stored)) delete index.consents[k]
			})
			changed()
		},
		inspect: inspectRepo,
		setUserModels,
		// the app's own storage (a phone: no other folder)
		chooseDirectory: () => Promise.resolve(null),
		onChange(cb) { changeListeners.add(cb); return () => { changeListeners.delete(cb) } },
		onFailure(cb) { failureListeners.add(cb); return () => { failureListeners.delete(cb) } }
	}
}

export function createLocalAi(): LocalAiApi {
	return {
		chat,
		abort: id => { void LocalAi.abort({ id }) },
		onEvent(cb) { chatListeners.add(cb); return () => { chatListeners.delete(cb) } },
		image: async (): Promise<AiOutcome<AiImageResult>> => ({ ok: false, code: 'unavailable', message: 'images are too slow on this device' }),
		speech,
		importFile,
		importedFiles,
		forgetFile
	}
}
