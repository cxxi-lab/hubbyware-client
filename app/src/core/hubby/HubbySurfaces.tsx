import { useEffect, useRef, useState } from 'react'
import type { ApiCall } from '@core/api/client'
import { ensureIntegrationForUrl, isIntegrationKnownSync } from '@shared/web/integrations'
import { syncPlayerBlocklist } from '@shared/web/playerBlocklist'
import type { HostMessage, SurfaceEvent, SurfaceState } from '@cxxi-lab/hubbyware-sdk/protocol'

/**
 * An isolated hubby's web surfaces (docs/plan-isolation.md D3): a webview can't live in its frame,
 * the host shows one over the place the frame gives (`<WebSurface>`), in the hubby's partition. The
 * host applies what the app's web socle does around a webview — the site's integration before it
 * loads and before each navigation to a site not seen yet, the shell's player blocklist — and
 * tells the frame the webview's events.
 */

export type WebviewElement = HTMLElement & {
	executeJavaScript(code: string): Promise<unknown>
	reload(): void
	loadURL(url: string): Promise<void>
	getURL(): string
	goBack(): void
	goForward(): void
	canGoBack(): boolean
	canGoForward(): boolean
}

export interface Surfaces {
	states: Record<number, SurfaceState>
	elements: Map<number, WebviewElement>
}

/** A covered surface waiting for the frame to show its picture before it steps aside (by surface id). */
const awaitingPicture = new Map<number, () => void>()

/** What the frame may ask of its surfaces (the host's methods). */
export function surfaceMethods(
	update: (id: number, state: SurfaceState | null) => void,
	elements: Map<number, WebviewElement>,
	call: ApiCall,
): Record<string, (...args: unknown[]) => unknown> {
	const element = (id: unknown) => {
		const el = typeof id === 'number' ? elements.get(id) : undefined
		if (!el) throw new Error('no such surface (not shown yet)')
		return el
	}
	return {
		'surface.update': (id: unknown, state: unknown) => {
			if (typeof id !== 'number' || typeof state !== 'object' || state === null) throw new Error('invalid surface')
			const s = state as SurfaceState
			if (typeof s.src !== 'string' || !/^https?:\/\//i.test(s.src)) throw new Error('a surface shows an http(s) page')
			update(id, s)
			return null
		},
		'surface.close': (id: unknown) => {
			if (typeof id === 'number') update(id, null)
			return null
		},
		'surface.exec': (id: unknown, code: unknown) => element(id).executeJavaScript(String(code)),
		'surface.reload': (id: unknown) => { element(id).reload(); return null },
		// the frame shows the page's picture: the page may step aside (no blank between them)
		'surface.pictureShown': (id: unknown) => { if (typeof id === 'number') awaitingPicture.get(id)?.(); return null },
		'surface.back': (id: unknown) => { const el = element(id); if (el.canGoBack()) el.goBack(); return null },
		'surface.forward': (id: unknown) => { const el = element(id); if (el.canGoForward()) el.goForward(); return null },
		'surface.load': async (id: unknown, url: unknown) => {
			if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('a surface loads an http(s) page')
			await ensureIntegrationForUrl(call, url)
			await element(id).loadURL(url)
			return null
		},
		'web.integration': (url: unknown) => typeof url === 'string' ? ensureIntegrationForUrl(call, url).then(() => null) : null
	}
}

/** The surfaces' webviews, over the frame (their places are the frame's coordinates). */
export function SurfaceViews({ hubby, surfaces, call, send }: {
	hubby: string
	surfaces: Surfaces
	call: ApiCall
	send: (message: HostMessage) => void
}) {
	return (
		<>
			{Object.entries(surfaces.states).map(([id, state]) => (
				<SurfaceView key={id} id={Number(id)} hubby={hubby} state={state} elements={surfaces.elements} call={call} send={send} />
			))}
		</>
	)
}

let blocklist: Promise<void> | null = null

function SurfaceView({ id, hubby, state, elements, call, send }: {
	id: number
	hubby: string
	state: SurfaceState
	elements: Map<number, WebviewElement>
	call: ApiCall
	send: (message: HostMessage) => void
}) {
	// what the webview loads: once the site's integration (and the blocklist) are in place
	const [src, setSrc] = useState<string | null>(null)
	useEffect(() => {
		let alive = true
		blocklist ??= syncPlayerBlocklist(call).catch(err => { blocklist = null; console.warn('[surfaces] blocklist', err) })
		void Promise.all([blocklist, ensureIntegrationForUrl(call, state.src)]).finally(() => { if (alive) setSrc(state.src) })
		return () => { alive = false }
	}, [state.src])

	const ref = useRef<WebviewElement | null>(null)
	useEffect(() => {
		const el = ref.current
		if (!el) return
		elements.set(id, el)
		const tell = (event: SurfaceEvent, pick: (e: Record<string, unknown>) => Record<string, unknown>) => {
			const listener = (e: Event) => send({ type: 'surface', surface: id, event, detail: pick(e as unknown as Record<string, unknown>) })
			el.addEventListener(event, listener)
			return () => el.removeEventListener(event, listener)
		}
		const offs = [
			tell('dom-ready', () => ({})),
			// with where its history stands (the frame's back / forward buttons)
			tell('did-navigate', e => ({ url: e.url, isMainFrame: true, canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })),
			tell('did-navigate-in-page', e => ({ url: e.url, isMainFrame: e.isMainFrame, canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })),
			tell('page-favicon-updated', e => ({ favicons: e.favicons })),
			tell('console-message', e => ({ message: e.message, level: e.level })),
			tell('did-fail-load', e => ({ errorCode: e.errorCode, errorDescription: e.errorDescription, validatedURL: e.validatedURL, isMainFrame: e.isMainFrame })),
		]
		// a site not seen yet: its integration first, then the page (as the app's browser did)
		const onWillNavigate = (e: Event) => {
			const ev = e as unknown as { url?: string, preventDefault: () => void }
			if (!ev.url || !/^https?:/.test(ev.url) || isIntegrationKnownSync(ev.url)) return
			ev.preventDefault()
			void ensureIntegrationForUrl(call, ev.url).finally(() => {
				el.loadURL(ev.url!).catch(err => console.warn('[surfaces] loadURL failed', err))
			})
		}
		el.addEventListener('will-navigate', onWillNavigate)
		return () => {
			offs.forEach(off => off())
			el.removeEventListener('will-navigate', onWillNavigate)
			if (elements.get(id) === el) elements.delete(id)
		}
	}, [src !== null])

	// covered (a menu of the frame over it): a picture of the page goes to the frame, shown in its
	// place, then the page steps aside — the frame's menu over what looks like the page
	const [aside, setAside] = useState(false)
	useEffect(() => {
		if (!state.covered) { setAside(false); return }
		const el = ref.current as (WebviewElement & { capturePage?: () => Promise<{ toDataURL(): string, isEmpty(): boolean }> }) | null
		let alive = true
		const capture = el?.capturePage?.()
		if (!capture) { setAside(true); return }
		// aside once the frame shows the picture (it says so), at the latest after a moment
		let timer: ReturnType<typeof setTimeout> | null = null
		const stepAside = () => { if (alive) setAside(true); awaitingPicture.delete(id); if (timer) clearTimeout(timer) }
		void capture.then(
			image => {
				if (!alive) return
				if (image.isEmpty()) { stepAside(); return }
				awaitingPicture.set(id, stepAside)
				timer = setTimeout(stepAside, 500)
				send({ type: 'surface', surface: id, event: 'snapshot', detail: { image: image.toDataURL() } })
			},
			stepAside
		)
		return () => { alive = false; awaitingPicture.delete(id); if (timer) clearTimeout(timer) }
	}, [state.covered])

	if (src === null) return null
	const rect = state.rect
	return (
		<webview
			ref={ref as never}
			// httpreferrer before src: a src change loads with the referrer as it stands
			{...{ httpreferrer: state.referrer ?? undefined }}
			src={src}
			partition={`persist:hubby:${hubby}`}
			useragent={state.userAgent ?? undefined}
			webpreferences={state.webPreferences ?? undefined}
			style={rect
				? { position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, display: 'inline-flex', visibility: state.covered && aside ? 'hidden' : 'visible' }
				: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, visibility: 'hidden' }}
		/>
	)
}
