import { createElement, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SurfaceEvent, SurfaceState } from '../protocol'
import { call, onHostMessage } from './sdk'

/**
 * A web page shown in the hubby (docs/plan-isolation.md D3): a webview can't live in a frame, the
 * host shows one over this place — in the hubby's partition, the site's integration applied before
 * it loads, the shell's player blocklist on. It takes a webview's attributes and its ref stands for
 * the webview (addEventListener of its events, executeJavaScript, reload, loadURL, getURL, goBack,
 * goForward, canGoBack / canGoForward as of its last navigation): a hubby
 * swaps `<webview>` for `<WebSurface>` and keeps its code. `covered`: something of the frame is over
 * it (a menu, an overlay): kept loaded, a picture of it shown in its place (the host's snapshot), so
 * the frame's menu shows over what looks like the page.
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
}

let nextSurface = 1
const surfaces = new Map<number, (event: SurfaceEvent, detail: Record<string, unknown>) => void>()

onHostMessage(m => {
	if (m.type === 'surface') surfaces.get(m.surface)?.(m.event, m.detail)
})

export const WebSurface = forwardRef<WebSurfaceElement, WebSurfaceProps>(function WebSurface(props, ref) {
	const place = useRef<HTMLDivElement>(null)
	const id = useMemo(() => nextSurface++, [])
	// the page as it was when covered (the host's picture), shown meanwhile
	const [snapshot, setSnapshot] = useState<string | null>(null)
	useEffect(() => { if (!props.covered) setSnapshot(null) }, [props.covered])
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
			emit(event, detail) {
				if (event === 'snapshot') {
					if (typeof detail.image === 'string' && detail.image.startsWith('data:image/')) setSnapshot(detail.image)
					return
				}
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

	return createElement('div', { ref: place, className: props.className, style: { ...props.style, position: 'relative' } },
		props.covered && snapshot ? createElement('img', { src: snapshot, alt: '', onLoad: () => { requestAnimationFrame(() => requestAnimationFrame(() => { void call('surface.pictureShown', id) })) }, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none' } }) : null)
})
