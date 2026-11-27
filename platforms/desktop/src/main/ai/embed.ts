import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

import { DEFAULT_LIMITS, holdGpu, releaseGpu } from './gpu'

/**
 * Image vectors on this device's GPU (docs/plan-discover-scan.md): the CLIP worker
 * (ai/embedWorker.ts) started on the first image, the model loaded once, stopped after a while
 * without images (it holds the GPU's memory). One image at a time, in order.
 */

const FLAG = '--hub-ai-embed-worker'
/** without an image this long, the worker goes (its model leaves the GPU) */
const IDLE_MS = Number(process.env.HUB_AI_EMBED_IDLE_MS ?? 60_000)
const START_TIMEOUT_MS = 30_000
const LOAD_TIMEOUT_MS = 120_000
const EMBED_TIMEOUT_MS = 20_000
const GPU_OWNER = 'embed'

type Reply =
	| { type: 'ready' }
	| { type: 'loaded', file: string, adapter: string | null }
	| { type: 'vector', id: number, vector: Float32Array }
	| { type: 'vectors', id: number, vectors: Float32Array[], duration: number | null }
	| { type: 'error', id?: number, message: string }

let child: ChildProcess | null = null
let started: Promise<void> | null = null
let loaded: string | null = null
let loading: Promise<void> | null = null
let nextId = 1
let idle: NodeJS.Timeout | null = null
const pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>()
let loadWaiter: { resolve: () => void, reject: (e: Error) => void } | null = null

function stop(): void {
	if (idle) clearTimeout(idle)
	idle = null
	child?.kill()
}

function armIdle(): void {
	if (idle) clearTimeout(idle)
	idle = setTimeout(stop, IDLE_MS)
}

function startWorker(): Promise<void> {
	if (started) return started
	started = new Promise<void>((resolve, reject) => {
		const args = [
			// development: the app's folder first (packaged, the executable knows its app)
			...(app.isPackaged ? [] : [app.getAppPath()]),
			FLAG,
			`--user-data-dir=${path.join(app.getPath('userData'), 'embed-worker')}`
		]
		const env = { ...process.env }
		delete env.ELECTRON_RUN_AS_NODE
		const proc = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', env })
		child = proc
		holdGpu(GPU_OWNER, DEFAULT_LIMITS)
		const timer = setTimeout(() => { reject(new Error('the AI worker did not start')); proc.kill() }, START_TIMEOUT_MS)
		proc.on('message', (m: Reply) => {
			if (m.type === 'ready') { clearTimeout(timer); resolve() }
			else if (m.type === 'loaded') { loaded = m.file; console.log(`[ai:embed] ${path.basename(m.file)} on ${m.adapter ?? 'no GPU adapter'}`); loadWaiter?.resolve(); loadWaiter = null }
			else if (m.type === 'vector') settle(m.id, null, m.vector)
			else if (m.type === 'vectors') settle(m.id, null, { vectors: m.vectors, duration: m.duration })
			else if (m.type === 'error') {
				if (m.id !== undefined) settle(m.id, new Error(m.message))
				else if (loadWaiter) { loadWaiter.reject(new Error(m.message)); loadWaiter = null }
				else console.warn('[ai:embed] worker:', m.message)
			}
		})
		proc.on('exit', code => {
			clearTimeout(timer)
			releaseGpu(GPU_OWNER)
			child = null
			started = null
			loaded = null
			loading = null
			const gone = new Error(`the AI worker stopped (${code ?? 'signal'})`)
			loadWaiter?.reject(gone)
			loadWaiter = null
			for (const id of [...pending.keys()]) settle(id, gone)
			reject(gone)
		})
	})
	return started
}

/** the worker's GPU in trouble (no answer, or nothing in it): a fresh worker next time */
const BROKEN = /GPU answered nothing|took too long|device lost|out of memory/i

function settle(id: number, error: Error | null, value?: unknown): void {
	const p = pending.get(id)
	if (!p) return
	if (error && BROKEN.test(error.message)) {
		console.warn('[ai:embed] the worker\'s GPU is in trouble: started afresh next time:', error.message)
		setTimeout(stop, 0)
	}
	pending.delete(id)
	clearTimeout(p.timer)
	// a long run of images: the worker stays while they come
	if (child) armIdle()
	if (error) p.reject(error)
	else p.resolve(value)
}

async function ensureModel(file: string): Promise<void> {
	await startWorker()
	if (loaded === file) return
	if (loading) await loading.catch(() => {})
	if (loaded === file) return
	loading = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('the image model took too long to load')), LOAD_TIMEOUT_MS)
		loadWaiter = { resolve: () => { clearTimeout(timer); resolve() }, reject: e => { clearTimeout(timer); reject(e) } }
		child?.send({ type: 'load', file })
	})
	try { await loading }
	finally { loading = null }
}

/**
 * The vector (L2-normalised) of an image: `pixels` its 224×224 RGB values, channel first, already
 * normalised as the model expects. `file`: the model's ONNX file.
 */
export async function embedPixels(file: string, pixels: Float32Array): Promise<Float32Array> {
	await ensureModel(file)
	armIdle()
	const id = nextId++
	return new Promise<Float32Array>((resolve, reject) => {
		const timer = setTimeout(() => settle(id, new Error('the image took too long')), EMBED_TIMEOUT_MS)
		pending.set(id, { resolve: v => resolve(v as Float32Array), reject, timer })
		child?.send({ type: 'embed', id, pixels })
	})
}

/** A clip's stills (spread over it) or an image, decoded and turned into vectors by the worker. */
export async function embedMedia(file: string, kind: 'image' | 'video', bytes: Uint8Array, frames?: number): Promise<{ vectors: Float32Array[], duration: number | null }> {
	await ensureModel(file)
	armIdle()
	const id = nextId++
	const timeout = kind === 'video' ? EMBED_TIMEOUT_MS + 3_000 * (frames ?? 15) : EMBED_TIMEOUT_MS
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => settle(id, new Error(`the ${kind} took too long`)), timeout)
		pending.set(id, { resolve: v => resolve(v as { vectors: Float32Array[], duration: number | null }), reject, timer })
		child?.send({ type: 'media', id, kind, bytes, frames })
	})
}

// the app quits: the worker goes and the GPU's clocks come back now (its exit would come too late)
app.on('will-quit', () => {
	stop()
	releaseGpu(GPU_OWNER, true)
})
