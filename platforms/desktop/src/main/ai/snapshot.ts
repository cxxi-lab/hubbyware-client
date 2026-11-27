import { app, nativeImage, webContents, type NativeImage, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { embedPixels } from './embed'
import { modelFiles, modelPlans } from './models'

/**
 * A web surface's picture (docs/plan-discover-scan.md): what a hubby's surface shows (a site's
 * video), captured as the page draws it, a small JPEG for the hubby to show and, when it asks, its
 * vector by one of its image models (family embed: CLIP on the GPU, ai/embed.ts).
 */

export interface SnapshotRequest {
	/** the element to capture (CSS selector, e.g. `video`), else the whole page */
	selector?: string
	/** the JPEG's width, 64–640 px (default 320) */
	thumbWidth?: number
	/** a model the hubby declares (family embed): the picture's vector too */
	model?: string
}

export interface SnapshotResult {
	/** data:image/jpeg URL */
	image: string
	/** the video's position (s), when the element is a video */
	time: number | null
	/** L2-normalised, when a model was asked */
	vector: number[] | null
}

export type SnapshotOutcome =
	| { ok: true, result: SnapshotResult }
	| { ok: false, code: 'consent' | 'missing' | 'unavailable' | 'invalid' | 'failed', message: string }

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const SIZE = 224
const invalid = (message: string): SnapshotOutcome => ({ ok: false, code: 'invalid', message })

/** The capture in its real pixels, at scale 1 (on a 125 % screen, it holds 1.25× its size in DIPs). */
function physical(image: NativeImage): NativeImage {
	const scaleFactor = image.getScaleFactors()[0] ?? 1
	if (scaleFactor === 1) return image
	const { width, height } = image.getSize(scaleFactor)
	return nativeImage.createFromBitmap(image.toBitmap({ scaleFactor }), { width, height, scaleFactor: 1 })
}

/** The model's pixels: the picture's shortest side to 224, its middle 224×224, RGB channel first, in [-1, 1]. */
function pixelsOf(capture: NativeImage): Float32Array {
	const image = physical(capture)
	const { width, height } = image.getSize()
	const scale = SIZE / Math.min(width, height)
	const w = Math.max(SIZE, Math.round(width * scale))
	const h = Math.max(SIZE, Math.round(height * scale))
	const square = image.resize({ width: w, height: h, quality: 'best' })
		.crop({ x: Math.floor((w - SIZE) / 2), y: Math.floor((h - SIZE) / 2), width: SIZE, height: SIZE })
	// BGRA, as Chromium keeps its bitmaps
	const bgra = square.toBitmap()
	const plane = SIZE * SIZE
	if (bgra.length !== plane * 4) throw new Error(`a ${SIZE}×${SIZE} picture was expected (${bgra.length / 4} pixels)`)
	const out = new Float32Array(3 * plane)
	for (let i = 0; i < plane; i++) {
		out[i] = bgra[i * 4 + 2] / 127.5 - 1
		out[plane + i] = bgra[i * 4 + 1] / 127.5 - 1
		out[2 * plane + i] = bgra[i * 4] / 127.5 - 1
	}
	return out
}

/** The element's place in the page (its visible part) and, for a video, its position. */
async function placeOf(wc: WebContents, selector: string): Promise<{ rect: Electron.Rectangle, time: number | null } | null> {
	const found = await wc.executeJavaScript(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)})
		if (!el) return null
		const r = el.getBoundingClientRect()
		const x = Math.max(0, r.left), y = Math.max(0, r.top)
		const right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom)
		return { x, y, width: right - x, height: bottom - y, time: typeof el.currentTime === 'number' ? el.currentTime : null }
	})()`) as { x: number, y: number, width: number, height: number, time: number | null } | null
	if (!found || found.width < 16 || found.height < 16) return null
	return { rect: { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) }, time: found.time }
}

/**
 * A snapshot of a hubby's surface: `surfaceId` the webview's WebContents (the app's renderer gives
 * it), `host` who asks (a webview of its own only).
 */
export async function snapshot(hubby: string, host: WebContents, surfaceId: unknown, request: unknown): Promise<SnapshotOutcome> {
	const r = (request ?? {}) as SnapshotRequest
	if (typeof r !== 'object') return invalid('snapshot({ selector?, thumbWidth?, model? })')
	if (r.selector !== undefined && (typeof r.selector !== 'string' || r.selector.length > 200)) return invalid('selector: a CSS selector')
	if (r.model !== undefined && (typeof r.model !== 'string' || !NAME.test(r.model))) return invalid('model: one of its models, by name')
	const thumbWidth = Math.min(640, Math.max(64, Math.round(Number(r.thumbWidth ?? 320)) || 320))
	const wc = typeof surfaceId === 'number' ? webContents.fromId(surfaceId) : undefined
	// only a surface the asking window shows
	if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== host) return invalid('no such surface')

	let file: string | null = null
	if (r.model) {
		const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === r.model)
		if (!plan || plan.invalid) return invalid(`${hubby} declares no model ${r.model} this device accepts`)
		if (plan.family !== 'embed') return invalid(`${r.model} is not an image vector model (family embed)`)
		if (plan.chosen === null) return { ok: false, code: 'unavailable', message: `${r.model} cannot run on this device` }
		if (!plan.consented) return { ok: false, code: 'consent', message: `${r.model} is not allowed on this device yet` }
		const files = modelFiles(hubby, r.model)
		file = files?.find(f => f.endsWith('.onnx')) ?? null
		if (!files) return { ok: false, code: 'missing', message: `${r.model} is not downloaded yet` }
		if (!file) return invalid(`${r.model}: an image vector model is an ONNX file`)
	}

	try {
		const t0 = performance.now()
		const place = r.selector ? await placeOf(wc, r.selector) : null
		const t1 = performance.now()
		if (r.selector && !place) return { ok: false, code: 'failed', message: `nothing to capture: ${r.selector} is not on the page` }
		const image = await wc.capturePage(place?.rect)
		if (image.isEmpty()) return { ok: false, code: 'failed', message: 'the page drew nothing' }
		const t2 = performance.now()
		const thumb = image.resize({ width: thumbWidth, quality: 'good' }).toJPEG(75)
		const t3 = performance.now()
		const pixels = file ? pixelsOf(image) : null
		const t4 = performance.now()
		const vector = file && pixels ? Array.from(await embedPixels(file, pixels)) : null
		if (process.env.HUB_AI_EMBED_DEBUG && !app.isPackaged && pixels && vector) {
			// development: the exact pixels, the capture (lossless) and the vector, to check against the CPU
			const dir = path.join(app.getPath('userData'), 'embed-debug')
			mkdirSync(dir, { recursive: true })
			writeFileSync(path.join(dir, 'pixels.f32'), Buffer.from(pixels.buffer))
			writeFileSync(path.join(dir, 'capture.png'), physical(image).toPNG())
			writeFileSync(path.join(dir, 'vector.json'), JSON.stringify(vector))
		}
		if (process.env.HUB_AI_EMBED_DEBUG) console.log(`[ai:snapshot] place ${Math.round(t1 - t0)} capture ${Math.round(t2 - t1)} thumb ${Math.round(t3 - t2)} pixels ${Math.round(t4 - t3)} embed ${Math.round(performance.now() - t4)} ms`)
		return { ok: true, result: { image: `data:image/jpeg;base64,${thumb.toString('base64')}`, time: place?.time ?? null, vector } }
	}
	catch (err) {
		return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
	}
}
