import { useEffect, useRef, useState } from 'react'
import type { ApiCall } from '@core/api/client'
import { ensureIntegrationForUrl, isIntegrationKnownSync } from '@shared/web/integrations'
import { syncPlayerBlocklist } from '@shared/web/playerBlocklist'
import type { HostMessage, SurfaceEvent, SurfaceState } from '@cxxi-lab/hubbyware-sdk/protocol'
import { platform } from '@platform'

/**
 * An isolated hubby's web surfaces (docs/plan-isolation.md D3): a webview can't live in its frame,
 * the host shows one over the place the frame gives (`<WebSurface>`), in the hubby's partition.
 * Covered (a menu of the frame over it): the webview goes under the frame (z-index), which is
 * see-through there meanwhile — the menu over the live page, nothing captured. The
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
	/** desktop's webview only: its WebContents (a snapshot is taken by the main process) */
	getWebContentsId?(): number
}

export interface Surfaces {
	states: Record<number, SurfaceState>
	elements: Map<number, WebviewElement>
}

/** What the frame may ask of its surfaces (the host's methods). */
export function surfaceMethods(
	update: (id: number, state: SurfaceState | null) => void,
	elements: Map<number, WebviewElement>,
	call: ApiCall,
	/** a picture of a surface (its webview's WebContents id), with its vector if asked: the host checks the scope */
	snapshot?: (surfaceId: number, request: unknown) => Promise<unknown>,
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
		'surface.back': (id: unknown) => { const el = element(id); if (el.canGoBack()) el.goBack(); return null },
		'surface.snapshot': (id: unknown, request: unknown) => {
			const el = element(id)
			if (!snapshot || typeof el.getWebContentsId !== 'function') throw new Error('unavailable: a surface\'s picture is taken on a desktop only')
			return snapshot(el.getWebContentsId(), request)
		},
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
				? { position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, display: 'inline-flex', zIndex: state.covered ? 0 : 2 }
				: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, visibility: 'hidden' }}
		/>
	)
}

/**
 * The surfaces as native views (Android: platform.nativeSurfaces): a WebView over the app's at the
 * frame's place plus the surface's, shown while the frame is (its own host may be hidden) and not
 * covered (a native view can't go under the frame: covered, it steps aside).
 */
export function NativeSurfaceViews({ surfaces, frame, call, send }: {
	surfaces: Surfaces
	frame: { current: HTMLIFrameElement | null }
	call: ApiCall
	send: (message: HostMessage) => void
}) {
	const native = platform.nativeSurfaces
	const { states, elements } = surfaces
	// where each one is shown, as last told to the native side
	const shown = useRef(new Map<number, string>())
	const history = useRef(new Map<number, { url: string, back: boolean, forward: boolean }>())

	// its events, told to the frame (and its history kept for canGoBack / canGoForward)
	useEffect(() => {
		if (!native) return
		return native.onEvent(e => {
			if (typeof e.detail.url === 'string' || typeof e.detail.canGoBack === 'boolean') {
				const h = history.current.get(e.id) ?? { url: '', back: false, forward: false }
				if (typeof e.detail.url === 'string') h.url = e.detail.url
				if (typeof e.detail.canGoBack === 'boolean') h.back = e.detail.canGoBack
				if (typeof e.detail.canGoForward === 'boolean') h.forward = e.detail.canGoForward
				history.current.set(e.id, h)
			}
			send({ type: 'surface', surface: e.id, event: e.event as SurfaceEvent, detail: e.detail })
		})
	}, [native])

	// the frame's methods on it (reload, back, exec…), as the desktop's webview elements answer them
	useEffect(() => {
		if (!native) return
		for (const id of Object.keys(states).map(Number)) {
			if (elements.has(id)) continue
			elements.set(id, {
				executeJavaScript: (code: string) => native.exec(id, code),
				reload: () => { void native.reload(id) },
				loadURL: (url: string) => native.load(id, url),
				getURL: () => history.current.get(id)?.url ?? states[id]?.src ?? '',
				goBack: () => { void native.back(id) },
				goForward: () => { void native.forward(id) },
				canGoBack: () => history.current.get(id)?.back ?? false,
				canGoForward: () => history.current.get(id)?.forward ?? false
			} as unknown as WebviewElement)
		}
		for (const id of [...shown.current.keys()]) {
			if (states[id]) continue
			shown.current.delete(id)
			history.current.delete(id)
			elements.delete(id)
			void native.close(id)
		}
	}, [states, native])

	// placed each frame: the frame moves (the app's layout) or hides (another hubby, another page)
	useEffect(() => {
		if (!native) return
		let raf = 0
		const tick = () => {
			const el = frame.current
			const box = el && el.offsetParent !== null ? el.getBoundingClientRect() : null
			for (const [key, state] of Object.entries(states)) {
				const id = Number(key)
				const r = state.rect
				const visible = !!box && !!r && !state.covered && box.width > 0
				const place = { x: (box?.left ?? 0) + (r?.x ?? 0), y: (box?.top ?? 0) + (r?.y ?? 0), width: r?.width ?? 0, height: r?.height ?? 0 }
				const signature = JSON.stringify([place, visible, state.src])
				if (shown.current.get(id) === signature) continue
				const first = !shown.current.has(id)
				shown.current.set(id, signature)
				const show = () => native.show({ id, ...place, visible, src: state.src, referrer: state.referrer, userAgent: state.userAgent }).catch(err => console.warn('[surfaces] show', err))
				// a new page: the site's integration (its cookies) first
				if (first) void ensureIntegrationForUrl(call, state.src).finally(show)
				else void show()
			}
			raf = requestAnimationFrame(tick)
		}
		tick()
		return () => cancelAnimationFrame(raf)
	}, [states, native])

	// gone with the host
	useEffect(() => () => {
		if (!native) return
		for (const id of shown.current.keys()) void native.close(id)
		shown.current.clear()
	}, [native])
	return null
}
