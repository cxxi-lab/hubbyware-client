import { createElement, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from 'react'
import type { SurfaceEvent, SurfaceState } from '../protocol'
import { call, onHostMessage } from './sdk'

/**
 * A web page shown in the hubby (docs/plan-isolation.md D3): a webview can't live in a frame, the
 * host shows one over this place — in the hubby's partition, the site's integration applied before
 * it loads, the shell's player blocklist on. It takes a webview's attributes and its ref stands for
 * the webview (addEventListener of its events, executeJavaScript, reload, loadURL, getURL, goBack,
 * goForward, canGoBack / canGoForward as of its last navigation): a hubby
 * swaps `<webview>` for `<WebSurface>` and keeps its code. `covered`: something of the frame is over
 * it (a menu, an overlay): the host puts the page under the frame, which is see-through over its
 * place meanwhile (this element and the document's background) — the menu over the live page.
 */
export interface WebSurfaceProps {
	src: string
	httpreferrer?: string
	useragent?: string
	webpreferences?: string
	/** the host chooses the hubby's own (accepted for the webview's form) */
	partition?: string
	className?: string
	style?: CSSProperties
	covered?: boolean
}

export interface WebSurfaceElement {
	addEventListener(event: SurfaceEvent | string, listener: (e: Event) => void): void
	removeEventListener(event: SurfaceEvent | string, listener: (e: Event) => void): void
	executeJavaScript(code: string): Promise<unknown>
	reload(): void
	loadURL(url: string): Promise<void>
	getURL(): string
	goBack(): void
	goForward(): void
	/** as of its last navigation (the host tells them with each did-navigate) */
	canGoBack(): boolean
	canGoForward(): boolean
	/**
	 * A picture of what it shows (desktop only), as the page draws it: `selector` an element of the
	 * page (e.g. `video`, its visible part; else the whole page), a JPEG `thumbWidth` wide (64–640,
	 * 320), and with `model` (one of the hubby's AI models, family embed, scope app:ai) its vector,
	 * by the device's GPU. `time`: the video's position, when a video was captured.
	 */
	snapshot(options?: SurfaceSnapshotOptions): Promise<SurfaceSnapshot>
}

export interface SurfaceSnapshotOptions {
	selector?: string
	thumbWidth?: number
	model?: string
}

export interface SurfaceSnapshot {
	/** data:image/jpeg URL */
	image: string
	time: number | null
	/** L2-normalised (a dot product is the cosine similarity), when a model was asked */
	vector: number[] | null
}

let nextSurface = 1

// how many surfaces are covered: the document see-through while any is (its own background off)
let covering = 0
function seeThrough(delta: number): void {
	covering = Math.max(0, covering + delta)
	const value = covering > 0 ? 'transparent' : ''
	document.documentElement.style.background = value
	document.body.style.background = value
}
const surfaces = new Map<number, (event: SurfaceEvent, detail: Record<string, unknown>) => void>()

onHostMessage(m => {
	if (m.type === 'surface') surfaces.get(m.surface)?.(m.event, m.detail)
})

export const WebSurface = forwardRef<WebSurfaceElement, WebSurfaceProps>(function WebSurface(props, ref) {
	const place = useRef<HTMLDivElement>(null)
	const id = useMemo(() => nextSurface++, [])
	// covered: the document see-through (the page shows under the frame); counted, several may be
	useEffect(() => {
		if (!props.covered) return
		seeThrough(+1)
		return () => seeThrough(-1)
	}, [props.covered])
	const url = useRef(props.src)
	const handle = useMemo<WebSurfaceElement & { emit: (event: SurfaceEvent, detail: Record<string, unknown>) => void }>(() => {
		const listeners = new Map<string, Set<(e: Event) => void>>()
		const history = { back: false, forward: false }
		return {
			addEventListener(event, listener) {
				let set = listeners.get(event)
				if (!set) listeners.set(event, set = new Set())
				set.add(listener)
			},
			removeEventListener(event, listener) { listeners.get(event)?.delete(listener) },
			executeJavaScript: code => call('surface.exec', id, code),
			reload: () => { void call('surface.reload', id) },
			loadURL: target => call<void>('surface.load', id, target),
			getURL: () => url.current,
			goBack: () => { void call('surface.back', id) },
			goForward: () => { void call('surface.forward', id) },
			canGoBack: () => history.back,
			canGoForward: () => history.forward,
			snapshot: options => call<SurfaceSnapshot>('surface.snapshot', id, options ?? {}),
			emit(event, detail) {
				if ((event === 'did-navigate' || event === 'did-navigate-in-page') && typeof detail.url === 'string' && detail.isMainFrame !== false) url.current = detail.url
				if (typeof detail.canGoBack === 'boolean') history.back = detail.canGoBack
				if (typeof detail.canGoForward === 'boolean') history.forward = detail.canGoForward
				// the webview's event, as its listeners read it (its fields on the event)
				const e = Object.assign(new Event(event), detail)
				listeners.get(event)?.forEach(l => l(e))
			}
		}
	}, [id])
	useImperativeHandle(ref, () => handle, [handle])

	useEffect(() => {
		surfaces.set(id, handle.emit)
		return () => {
			surfaces.delete(id)
			void call('surface.close', id)
		}
	}, [id])

	// where it is, what it shows: told to the host as it changes (each frame: a modal animating,
	// a page scrolling move it without resizing it)
	const { src, httpreferrer, useragent, webpreferences, covered } = props
	useEffect(() => { url.current = src }, [src])
	useEffect(() => {
		let frame = 0
		let last = ''
		const tick = () => {
			const el = place.current
			const r = el?.getBoundingClientRect()
			const shown = !!el && !!r && r.width > 0 && r.height > 0 && el.offsetParent !== null
			const state: SurfaceState = {
				rect: shown ? { x: r.left, y: r.top, width: r.width, height: r.height } : null,
				src,
				referrer: httpreferrer ?? null,
				userAgent: useragent ?? null,
				webPreferences: webpreferences ?? null,
				covered: !!covered
			}
			const key = JSON.stringify(state)
			if (key !== last) {
				last = key
				void call('surface.update', id, state)
			}
			frame = requestAnimationFrame(tick)
		}
		tick()
		return () => cancelAnimationFrame(frame)
	}, [id, src, httpreferrer, useragent, webpreferences, covered])

	return createElement('div', { ref: place, className: props.className, style: props.covered ? { ...props.style, background: 'transparent' } : props.style })
})
