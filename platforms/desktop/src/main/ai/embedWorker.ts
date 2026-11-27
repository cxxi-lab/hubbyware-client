import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The CLIP worker (docs/plan-discover-scan.md): the desktop's executable started apart by the app
 * (ai/embed.ts) with `--hub-ai-embed-worker`, so that WebGPU can run on Vulkan (Linux) without the
 * app's own rendering switching to it. A hidden page runs onnxruntime-web on the GPU: it loads an
 * image model (an ONNX file the app found among the hubby's models) and turns 224×224 pixels into a
 * vector. Messages with the app go through the process's IPC channel (advanced serialization:
 * typed arrays as they are):
 *   → { type: 'load', file }           ← { type: 'loaded', file, adapter } | { type: 'error', message }
 *   → { type: 'embed', id, pixels }    ← { type: 'vector', id, vector } | { type: 'error', id, message }
 * It quits when the app goes (its channel closes).
 */

type Incoming = { type: 'load', file: string } | { type: 'embed', id: number, pixels: Float32Array }

const send = (message: unknown) => process.send?.(message)

// WebGPU reaches the dedicated GPU through Vulkan on Linux (Windows: D3D12, macOS: Metal, as they are)
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'Vulkan')
app.commandLine.appendSwitch('enable-unsafe-webgpu')
// no window, no dock icon: a worker
app.on('window-all-closed', () => { /* stays until the app goes */ })
process.on('disconnect', () => app.exit(0))

/** The page: onnxruntime-web's WebGPU build, a session per model file, one image at a time. */
function pageSource(ort: string): string {
	return `<!doctype html><meta charset="utf-8"><script type="module">
const { ipcRenderer } = require('electron')
const fs = require('fs')
const ort = await import(${JSON.stringify(ort)})
ort.env.wasm.numThreads = 1
// the dedicated GPU (a laptop's integrated one is the default)
ort.env.webgpu.powerPreference = 'high-performance'
let session = null, file = null, input = null, output = null
ipcRenderer.on('load', async (_e, f) => {
	try {
		if (file !== f) {
			await session?.release()
			session = null
			const buf = fs.readFileSync(f)
			session = await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' })
			file = f; input = session.inputNames[0]; output = session.outputNames[0]
		}
		const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
		ipcRenderer.send('loaded', { file: f, adapter: adapter ? adapter.info.vendor + ' ' + adapter.info.architecture : null })
	}
	catch (err) { ipcRenderer.send('failed', { message: String(err?.message ?? err) }) }
})
ipcRenderer.on('embed', async (_e, { id, pixels }) => {
	try {
		if (!session) throw new Error('no model loaded')
		const t = performance.now()
		const out = await session.run({ [input]: new ort.Tensor('float32', pixels, [1, 3, 224, 224]) })
		if (${JSON.stringify(!!process.env.HUB_AI_EMBED_DEBUG)}) console.log('[ai:embed] run', Math.round(performance.now() - t), 'ms')
		const v = Float32Array.from(out[output].data)
		let n = 0; for (const x of v) n += x * x
		n = Math.sqrt(n) || 1
		for (let i = 0; i < v.length; i++) v[i] /= n
		ipcRenderer.send('vector', { id, vector: v })
	}
	catch (err) { ipcRenderer.send('failed', { id, message: String(err?.message ?? err) }) }
})
ipcRenderer.send('ready')
</script>`
}

async function start(): Promise<void> {
	await app.whenReady()
	// onnxruntime-web's WebGPU build, beside the app's code (inside its asar once packaged)
	const require = createRequire(import.meta.url)
	const dist = path.dirname(require.resolve('onnxruntime-web'))
	const ort = pathToFileURL(path.join(dist, 'ort.webgpu.bundle.min.mjs')).href
	// a file page: WebGPU needs a secure context (a data: URL is not one)
	const dir = path.join(app.getPath('userData'), 'page')
	mkdirSync(dir, { recursive: true })
	const page = path.join(dir, 'embed.html')
	writeFileSync(page, pageSource(ort))
	const win = new BrowserWindow({
		show: false,
		// its own page only (no remote content): Node for reading the model file
		webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false }
	})
	const ready = new Promise<void>(resolve => ipcMain.once('ready', () => resolve()))
	ipcMain.on('loaded', (_e, m: { file: string, adapter: string | null }) => send({ type: 'loaded', ...m }))
	ipcMain.on('vector', (_e, m: { id: number, vector: Float32Array }) => send({ type: 'vector', ...m }))
	ipcMain.on('failed', (_e, m: { id?: number, message: string }) => send({ type: 'error', ...m }))
	// its page's own messages (development: timings) in the app's log
	win.webContents.on('console-message', e => { if (e.message.startsWith('[ai:')) console.log(e.message) })
	win.webContents.on('render-process-gone', (_e, details) => {
		send({ type: 'error', message: `the worker's page is gone (${details.reason})` })
		app.exit(1)
	})
	await win.loadFile(page)
	await ready
	process.on('message', (m: Incoming) => {
		if (m.type === 'load') win.webContents.send('load', m.file)
		else if (m.type === 'embed') win.webContents.send('embed', { id: m.id, pixels: m.pixels })
	})
	send({ type: 'ready' })
}

start().catch(err => {
	send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
	app.exit(1)
})
