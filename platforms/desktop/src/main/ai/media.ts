import { net } from 'electron'

import { embedMedia } from './embed'
import { modelFiles, modelPlans } from './models'

/**
 * Image vectors of pictures and clips a hubby names (docs/plan-auto-desktop.md phase 1): Discover
 * Auto's frames on the desktop's GPU. The files come from the Hubbyware server (the app checks the
 * address: its media proxy), downloaded here, decoded and embedded by the CLIP worker (ai/embed.ts).
 */

type Failure = { ok: false, code: 'consent' | 'missing' | 'unavailable' | 'invalid' | 'failed', message: string }
export type MediaOutcome<T> = { ok: true, result: T } | Failure

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const MAX_IMAGES = 60
const IMAGE_BYTES = 10 * 2 ** 20
const VIDEO_BYTES = 80 * 2 ** 20
const FETCH_TIMEOUT_MS = 60_000
const invalid = (message: string): Failure => ({ ok: false, code: 'invalid', message })

/** The ONNX file of a hubby's image model (family embed) it may use here, else why not. */
export async function embedModelFile(hubby: string, model: string): Promise<{ ok: true, file: string } | Failure> {
	if (!NAME.test(model)) return invalid('model: one of its models, by name')
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === model)
	if (!plan || plan.invalid) return invalid(`${hubby} declares no model ${model} this device accepts`)
	if (plan.family !== 'embed') return invalid(`${model} is not an image vector model (family embed)`)
	if (plan.chosen === null) return { ok: false, code: 'unavailable', message: `${model} cannot run on this device` }
	if (!plan.consented) return { ok: false, code: 'consent', message: `${model} is not allowed on this device yet` }
	const files = modelFiles(hubby, model)
	if (!files) return { ok: false, code: 'missing', message: `${model} is not downloaded yet` }
	const file = files.find(f => f.endsWith('.onnx'))
	return file ? { ok: true, file } : invalid(`${model}: an image vector model is an ONNX file`)
}

async function download(url: string, max: number): Promise<Uint8Array> {
	if (!/^https?:\/\//i.test(url)) throw new Error('an http(s) address')
	const res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
	if (!res.ok) throw new Error(`${res.status} for ${url.slice(0, 120)}`)
	const bytes = new Uint8Array(await res.arrayBuffer())
	if (bytes.length > max) throw new Error(`too large (${Math.round(bytes.length / 2 ** 20)} MB)`)
	return bytes
}

/** Each image's vector (L2-normalised), null where it could not be fetched or decoded. */
export async function embedImages(hubby: string, request: unknown): Promise<MediaOutcome<{ vectors: Array<number[] | null>, errors: Array<string | null> }>> {
	const r = request as { model?: unknown, urls?: unknown } | null
	if (!r || typeof r.model !== 'string' || !Array.isArray(r.urls) || r.urls.some(u => typeof u !== 'string')) return invalid('embedImages({ model, urls })')
	if (r.urls.length === 0 || r.urls.length > MAX_IMAGES) return invalid(`urls: 1 to ${MAX_IMAGES}`)
	const model = await embedModelFile(hubby, r.model)
	if (!model.ok) return model
	const vectors: Array<number[] | null> = []
	const errors: Array<string | null> = []
	// fetched together, embedded one by one (the GPU takes one at a time)
	const fetched = await Promise.allSettled((r.urls as string[]).map(u => download(u, IMAGE_BYTES)))
	for (const f of fetched) {
		if (f.status === 'rejected') { vectors.push(null); errors.push(String(f.reason?.message ?? f.reason)); continue }
		try {
			const out = await embedMedia(model.file, 'image', f.value)
			vectors.push(Array.from(out.vectors[0]))
			errors.push(null)
		}
		catch (err) { vectors.push(null); errors.push(err instanceof Error ? err.message : String(err)) }
	}
	return { ok: true, result: { vectors, errors } }
}

/** A clip's `frames` stills (spread over it, 15 by default) as vectors, and its length (s). */
export async function embedVideo(hubby: string, request: unknown): Promise<MediaOutcome<{ vectors: number[][], duration: number | null }>> {
	const r = request as { model?: unknown, url?: unknown, frames?: unknown } | null
	if (!r || typeof r.model !== 'string' || typeof r.url !== 'string') return invalid('embedVideo({ model, url, frames? })')
	const frames = r.frames === undefined ? 15 : Number(r.frames)
	if (!Number.isInteger(frames) || frames < 1 || frames > 60) return invalid('frames: 1 to 60')
	const model = await embedModelFile(hubby, r.model)
	if (!model.ok) return model
	try {
		const out = await embedMedia(model.file, 'video', await download(r.url, VIDEO_BYTES), frames)
		return { ok: true, result: { vectors: out.vectors.map(v => Array.from(v)), duration: out.duration } }
	}
	catch (err) {
		return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
	}
}
