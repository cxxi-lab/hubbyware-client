import { app, ipcMain, type Session } from 'electron'
import { onWebSession, webviewSessions } from './sessions'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export interface IntegrationCookie {
	name: string
	value: string
	/** the devices it is for ("desktop", "phone"); none: every one (a site's layout cookie: its desktop's) */
	devices?: string[]
}

export interface IntegrationReferer {
	url: string
	cdnHostPattern: string
}

export interface WebsiteIntegration {
	cookies?: IntegrationCookie[] | null
	referer?: IntegrationReferer | null
}

interface CacheEntry {
	integration: WebsiteIntegration
	updatedAt: number
}

const CACHE_PATH = join(app.getPath('userData'), 'integrations-cache.json')
const ONE_YEAR_SEC = 365 * 24 * 3600

class IntegrationsRegistry {
	private cache = new Map<string, CacheEntry>()
	private hookedSessions = new WeakSet<Session>()

	constructor() {
		this.load()
	}

	private load(): void {
		if (!existsSync(CACHE_PATH)) return
		try {
			const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, CacheEntry>
			for (const [host, entry] of Object.entries(raw)) {
				this.cache.set(host, entry)
			}
		}
		catch (err) {
			console.warn('[integrations] failed to load cache:', err)
		}
	}

	private persist(): void {
		try {
			mkdirSync(dirname(CACHE_PATH), { recursive: true })
			const obj: Record<string, CacheEntry> = {}
			for (const [k, v] of this.cache) obj[k] = v
			writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 })
		}
		catch (err) {
			console.warn('[integrations] failed to persist cache:', err)
		}
	}

	list(): Array<{ host: string; updatedAt: number }> {
		return [...this.cache.entries()].map(([host, e]) => ({ host, updatedAt: e.updatedAt }))
	}

	async apply(host: string, integration: WebsiteIntegration, updatedAt: number): Promise<void> {
		this.cache.set(host, { integration, updatedAt })
		this.persist()
		for (const [, sess] of webviewSessions()) {
			this.installHook(sess)
			await this.applyCookies(host, integration, sess)
		}
	}

	async remove(host: string): Promise<void> {
		const entry = this.cache.get(host)
		if (!entry) return
		this.cache.delete(host)
		this.persist()
		for (const [, sess] of webviewSessions()) {
			for (const c of entry.integration.cookies ?? []) {
				await sess.cookies.remove(`https://www.${host}`, c.name).catch(() => {})
				await sess.cookies.remove(`https://${host}`, c.name).catch(() => {})
			}
		}
	}

	/** On every webview session, the ones known and the ones to come (each hubby's). */
	async applyAll(): Promise<void> {
		onWebSession(sess => this.applyAllIn(sess))
	}

	private async applyAllIn(sess: Session): Promise<void> {
		this.installHook(sess)
		for (const [host, entry] of this.cache) {
			await this.applyCookies(host, entry.integration, sess)
		}
	}

	private async applyCookies(host: string, integration: WebsiteIntegration, sess: Session): Promise<void> {
		if (!integration.cookies) return
		const expirationDate = Math.floor(Date.now() / 1000) + ONE_YEAR_SEC
		// a cookie for some devices only (`devices`: "desktop", "phone"): a phone's not set here
		await Promise.all(integration.cookies.filter(c => !Array.isArray(c.devices) || c.devices.includes('desktop')).map(c =>
			sess.cookies.set({
				url: `https://www.${host}`,
				name: c.name,
				value: c.value,
				domain: `.${host}`,
				path: '/',
				secure: true,
				expirationDate,
			}).catch(err => console.warn('[integrations] cookie set failed:', err))
		))
	}

	private installHook(sess: Session): void {
		if (this.hookedSessions.has(sess)) return
		this.hookedSessions.add(sess)
		sess.webRequest.onBeforeSendHeaders((details, callback) => {
			try {
				const reqHost = new URL(details.url).hostname
				for (const [, entry] of this.cache) {
					const ref = entry.integration.referer
					if (!ref) continue
					const re = new RegExp(ref.cdnHostPattern)
					if (re.test(reqHost)) {
						details.requestHeaders['Referer'] = ref.url
						break
					}
				}
			}
			catch {}
			callback({ requestHeaders: details.requestHeaders })
		})
	}
}

export const integrationsRegistry = new IntegrationsRegistry()

ipcMain.handle('integrations:list', () => integrationsRegistry.list())

ipcMain.handle('integrations:apply', async (_, payload: { host: string; integration: WebsiteIntegration; updatedAt: number }) => {
	await integrationsRegistry.apply(payload.host, payload.integration, payload.updatedAt)
})

ipcMain.handle('integrations:remove', async (_, host: string) => {
	await integrationsRegistry.remove(host)
})
