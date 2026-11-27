import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import { applyMenu } from '../app/menu'
import { localEngine, reapOrphanServer } from './engine'
import { chat } from './chat'
import { generateImage } from './image'
import { speak } from './speech'
import { snapshot } from './snapshot'
import { embedImages, embedVideo } from './media'
import { forgetFile, importedFiles, importFile, type ImportKind } from './imports'
import { openMcpSession } from './mcp'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deviceInfo, downloadModel, inspectRepo, installedModels, modelEvents, modelPlans, removeModel, setModelsDirectory, setUserModels } from './models'

/**
 * The local AI engine in the desktop (client docs/plan-ia-moteur.md): its state in the menu, and
 * never left running after the app quits (it holds the GPU's memory). Development only:
 * HUB_AI_ENGINE_SELFTEST=<a GGUF file> starts it at launch, asks it one question with and without
 * its token, and logs what happened ([ai:selftest]).
 */
export function setupLocalAi(): void {
	// a server a crashed (or killed) run left behind: stopped
	reapOrphanServer()
	// killed (SIGTERM, Ctrl+C in a terminal): the engine first, then the app quits as usual
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.once(signal, () => { void localEngine.stop(true); app.quit() })
	}
	localEngine.on('status', () => applyMenu())
	// the models on this device (the Models screen of Settings): their state, pushed to every window
	ipcMain.handle('ai-models:state', async () => ({ device: await deviceInfo(), plans: await modelPlans(), installed: installedModels() }))
	ipcMain.handle('ai-models:download', (_e, hubby: unknown, name: unknown) => {
		if (typeof hubby !== 'string' || typeof name !== 'string') throw new Error('invalid model')
		// resolves now: the download goes on, its progress comes with ai-models:changed
		downloadModel(hubby, name).catch(err => {
			console.error(`[ai:models] ${hubby} ${name}:`, err)
			for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai-models:failed', { hubby, name, error: err instanceof Error ? err.message : String(err) })
		})
	})
	// models added by link (the app has checked the hubby's scope app:ai-links)
	ipcMain.handle('ai-models:inspect', (_e, link: unknown) => inspectRepo(String(link)))
	ipcMain.handle('ai-models:set-user', (_e, hubby: unknown, list: unknown) => {
		if (typeof hubby !== 'string') throw new Error('invalid hubby')
		return setUserModels(hubby, list)
	})
	ipcMain.handle('ai-models:remove', (_e, sha256: unknown) => removeModel(String(sha256)))
	ipcMain.handle('ai-models:directory', async () => {
		const res = await dialog.showOpenDialog({ title: 'Where AI models go', properties: ['openDirectory', 'createDirectory'] })
		if (res.canceled || !res.filePaths[0]) return null
		setModelsDirectory(res.filePaths[0])
		return res.filePaths[0]
	})
	// ai.chat (the app has checked the hubby's scope): the answer streams to the window that asked
	const chats = new Map<number, AbortController>()
	ipcMain.handle('ai:chat', (e, id: unknown, hubby: unknown, request: unknown) => {
		if (typeof id !== 'number' || typeof hubby !== 'string') return { ok: false, code: 'invalid', message: 'invalid chat' }
		const controller = new AbortController()
		chats.set(id, controller)
		return chat(hubby, request, (kind, text) => { if (!e.sender.isDestroyed()) e.sender.send('ai:chat:event', { id, kind, text }) }, controller.signal)
			.finally(() => chats.delete(id))
	})
	ipcMain.on('ai:chat:abort', (_e, id: unknown) => { if (typeof id === 'number') chats.get(id)?.abort() })
	// ai.image, ai.speech (the app has checked the hubby's scope), aborted like a chat (same ids)
	ipcMain.handle('ai:image', (_e, id: unknown, hubby: unknown, request: unknown) => {
		if (typeof id !== 'number' || typeof hubby !== 'string') return { ok: false, code: 'invalid', message: 'invalid image' }
		const controller = new AbortController()
		chats.set(id, controller)
		return generateImage(hubby, request, controller.signal).finally(() => chats.delete(id))
	})
	ipcMain.handle('ai:speech', (_e, id: unknown, hubby: unknown, request: unknown) => {
		if (typeof id !== 'number' || typeof hubby !== 'string') return { ok: false, code: 'invalid', message: 'invalid speech' }
		const controller = new AbortController()
		chats.set(id, controller)
		return speak(hubby, request, controller.signal).finally(() => chats.delete(id))
	})
	// a surface's picture, and its vector by an image model (the app has checked the hubby's scope)
	ipcMain.handle('ai:snapshot', (e, hubby: unknown, surfaceId: unknown, request: unknown) => {
		if (typeof hubby !== 'string') return { ok: false, code: 'invalid', message: 'invalid snapshot' }
		return snapshot(hubby, e.sender, surfaceId, request)
	})
	// the vectors of pictures and clips on the Hubbyware server (the app has checked the scope and the address)
	ipcMain.handle('ai:embed-images', (_e, hubby: unknown, request: unknown) => typeof hubby === 'string' ? embedImages(hubby, request) : { ok: false, code: 'invalid', message: 'invalid hubby' })
	ipcMain.handle('ai:embed-video', (_e, hubby: unknown, request: unknown) => typeof hubby === 'string' ? embedVideo(hubby, request) : { ok: false, code: 'invalid', message: 'invalid hubby' })
	// files the user imports for a hubby (a checkpoint, a LoRA, a voice sample): the dialog is the consent
	ipcMain.handle('ai-files:add', (e, hubby: unknown, kind: unknown) => {
		if (typeof hubby !== 'string' || !['checkpoint', 'lora', 'audio'].includes(String(kind))) throw new Error('a kind of file: checkpoint, lora or audio')
		return importFile(hubby, kind as ImportKind, BrowserWindow.fromWebContents(e.sender))
	})
	ipcMain.handle('ai-files:list', (_e, hubby: unknown) => importedFiles(typeof hubby === 'string' ? hubby : null))
	ipcMain.handle('ai-files:forget', (_e, sha256: unknown) => forgetFile(String(sha256)))
	modelEvents.on('changed', () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai-models:changed') })
	app.on('will-quit', () => { void localEngine.stop(true) })
	const model = process.env.HUB_AI_ENGINE_SELFTEST
	if (model && !app.isPackaged) void selfTest(model)
	// development: HUB_AGENT_MCP_DEVTEST=<a conversation id> opens an MCP session for the AI hubby
	// once the window is up, its url and token in <userData>/mcp-dev.json (a test agent connects)
	const devConversation = process.env.HUB_AGENT_MCP_DEVTEST
	if (devConversation && !app.isPackaged) {
		app.once('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => {
			void openMcpSession('ai', devConversation, win.webContents).then(s => {
				writeFileSync(join(app.getPath('userData'), 'mcp-dev.json'), JSON.stringify({ url: s.url, token: s.token }), { mode: 0o600 })
				console.log(`[ai:mcp] dev session for ${devConversation}: ${s.url}`)
			})
		}))
	}
}

async function selfTest(model: string): Promise<void> {
	const log = (...args: unknown[]) => console.log('[ai:selftest]', ...args)
	try {
		const started = Date.now()
		await localEngine.text(model)
		log(`on in ${Date.now() - started} ms`, localEngine.getInfo())
		const body = JSON.stringify({ messages: [{ role: 'user', content: 'Réponds en un mot : quelle est la capitale de la France ?' }], max_tokens: 16, temperature: 0, chat_template_kwargs: { enable_thinking: false } })
		const res = await localEngine.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
		const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>, timings?: { predicted_per_second?: number } }
		log('with its token:', res.status, JSON.stringify(data.choices?.[0]?.message?.content), `${data.timings?.predicted_per_second?.toFixed(1)} t/s`)
		const url = (localEngine as unknown as { url: string }).url
		const bare = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
		log('without a token:', bare.status)
		log('waiting for the idle stop…')
	}
	catch (err) {
		log('failed:', err)
	}
}
