import { createElement, Fragment, StrictMode, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import type { HubbyPage } from '../protocol'
import { connect, nav, register, serveApi, useInit, usePath, type ApiHandler } from './sdk'

/**
 * A hubby's front (docs/spec-hubby.md § 6) in its frame, in one of two forms:
 *  - its pages (`pages`), each a component; those with a `nav` section make its navigation;
 *  - the form of its manifest in the app (`navItems`, `routes`, `providers`: docs/plan-isolation.md
 *    § 2): its pages are chosen by their path as in the app (exact, or under it for a `prefix`
 *    route; a `persistent` one stays mounted once visited), inside react-router — the frame's
 *    location follows the app's, so `useLocation`, `useNavigate`, `Link` and the paths
 *    `/<id>/…` work as they do in the app.
 * Either way the host builds the navigation (the column on desktop, the bottom bar on phones).
 * Its `api`: the methods it offers the other hubbies (docs/plan-api-hubbies.md), described by its
 * api.json; they run in its frame — the one open, else one the host starts unseen to answer.
 */
export interface HubbyPageDefinition {
	/** relative to the hubby: '/', '/settings', '/:id' */
	path: string
	component: ComponentType<{ params: Record<string, string> }>
	title?: string
	icon?: unknown
	nav?: { section?: string }
}

export interface PagesDefinition {
	pages: HubbyPageDefinition[]
	/** the sections' icons in the navigation, by title */
	navSections?: Record<string, unknown>
	api?: Record<string, ApiHandler>
}

/** The form of a hubby's manifest (what the frame uses of it; the rest is the host's or left out). */
export interface ManifestDefinition {
	/** `phone`: on a phone's bottom bar, a tab, the round button in the middle, or not there (protocol.ts HubbyPage) */
	navItems: Array<{ to: string, label: string, section?: string, icon?: unknown, home?: boolean, phone?: 'tab' | 'primary' | 'hidden' }>
	navSections?: Record<string, unknown>
	routes: Array<{ path: string, Component: ComponentType, persistent?: boolean, prefix?: boolean }>
	/** contexts around all its pages, outermost first */
	providers?: Array<ComponentType<{ children: ReactNode }>>
	api?: Record<string, ApiHandler>
	pages?: never
}

export type HubbyDefinition = PagesDefinition | ManifestDefinition

export function defineHubby<D extends HubbyDefinition>(definition: D): D {
	return definition
}

/** The page matching a path, with its parameters (`:name` segments). */
export function match(pages: HubbyPageDefinition[], path: string): { page: HubbyPageDefinition, params: Record<string, string> } | null {
	const parts = path.split('/').filter(Boolean)
	for (const page of pages) {
		const pattern = page.path.split('/').filter(Boolean)
		if (pattern.length !== parts.length) continue
		const params: Record<string, string> = {}
		if (pattern.every((p, i) => p.startsWith(':') ? (params[p.slice(1)] = decodeURIComponent(parts[i]), true) : p === parts[i])) {
			return { page, params }
		}
	}
	return null
}

function PagesRouter({ definition }: { definition: PagesDefinition }) {
	const path = usePath()
	const found = match(definition.pages, path)
	if (!found) return createElement('p', { className: 'p-6 text-sm text-steel-400' }, `Nothing at ${path}`)
	return createElement(found.page.component, { params: found.params })
}

// --- the manifest's form ---

const pathOnly = (path: string) => path.split(/[?#]/)[0] || '/'
/** Its query (`?session=…`), '' without one. */
const queryOf = (path: string) => { const at = path.indexOf('?'); return at < 0 ? '' : path.slice(at).split('#')[0] }

/** The app's path of a page of the hubby (`/` → `/<id>`), and back (null: not one of its pages). */
const absolute = (id: string, inner: string) => `/${id}${inner === '/' ? '' : inner}`
function innerOf(id: string, path: string): string | null {
	const base = `/${id}`
	if (path === base) return '/'
	return path.startsWith(`${base}/`) ? path.slice(base.length) : null
}

/** The frame's location follows the app's (the host's `path`), and tells it where the hubby went. */
function LocationSync({ id }: { id: string }) {
	const host = usePath()
	const location = useLocation()
	const navigate = useNavigate()
	const hostPath = useRef(host)
	hostPath.current = host

	// the app moved (its navigation, back, a link of another hubby to one of its items): the frame
	// follows, its query too, without a new history entry
	useEffect(() => {
		const target = absolute(id, pathOnly(host)) + queryOf(host)
		if (target !== location.pathname + location.search) navigate(target, { replace: true })
	}, [host])

	// the hubby moved (a link, navigate()): the app follows
	useEffect(() => {
		const inner = innerOf(id, location.pathname)
		if (inner === null) {
			console.warn(`[hubby] ${location.pathname} is not a page of ${id}: a hubby only navigates in its own pages`)
			return
		}
		if (inner + location.search !== pathOnly(hostPath.current) + queryOf(hostPath.current)) nav.navigate(inner + location.search)
	}, [location.pathname, location.search])
	return null
}

function KeepAlive({ when, children }: { when: boolean, children: ReactNode }) {
	const [visited, setVisited] = useState(when)
	useEffect(() => { if (when) setVisited(true) }, [when])
	if (!visited) return null
	return createElement('div', { className: when ? 'contents' : 'hidden' }, children)
}

function ManifestPages({ definition, id }: { definition: ManifestDefinition, id: string }) {
	const { pathname } = useLocation()
	const navigate = useNavigate()
	// the hubby's root, no page of its own there: its home (as the app opens a hubby)
	const home = (definition.navItems.find(i => i.home) ?? definition.navItems[0])?.to ?? definition.routes[0]?.path
	const atRoot = pathname === `/${id}` && home !== undefined && home !== pathname && !definition.routes.some(r => r.path === pathname)
	useEffect(() => { if (atRoot) navigate(home!, { replace: true }) }, [atRoot])
	const matches = (route: ManifestDefinition['routes'][number]) => pathname === route.path || (!!route.prefix && pathname.startsWith(`${route.path}/`))
	const pages = definition.routes.map(route => route.persistent
		? createElement(KeepAlive, { key: route.path, when: matches(route), children: createElement(route.Component) })
		: matches(route) ? createElement(route.Component, { key: route.path }) : null)
	const content = definition.routes.some(matches) || atRoot
		? createElement(Fragment, null, ...pages)
		: createElement(Fragment, null, ...pages, createElement('p', { key: '_none', className: 'p-6 text-sm text-steel-400' }, `Nothing at ${pathname}`))
	return (definition.providers ?? []).reduceRight<ReactNode>((inner, Provider) => createElement(Provider, { children: inner }), content)
}

/** Waits for the host's `init` (the hubby's id, its path), then runs the hubby inside react-router. */
function ManifestRoot({ definition }: { definition: ManifestDefinition }) {
	const init = useInit()
	const registered = useRef(false)
	useEffect(() => {
		if (!init || registered.current) return
		registered.current = true
		const pages: HubbyPage[] = definition.navItems.map(item => ({
			path: innerOf(init.hubby, pathOnly(item.to)) ?? item.to,
			title: item.label,
			icon: item.icon,
			section: item.section ?? '',
			...(item.phone ? { phone: item.phone } : {})
		}))
		register(pages, definition.navSections ?? {})
	}, [init])
	if (!init) return null
	return createElement(MemoryRouter, { initialEntries: [absolute(init.hubby, init.path)] },
		createElement(LocationSync, { id: init.hubby }),
		createElement(ManifestPages, { definition, id: init.hubby }))
}

/** Runs a hubby in its frame: announces its pages to the host, renders the one it is on. */
export function start(definition: HubbyDefinition): void {
	if (definition.api) serveApi(definition.api)
	// a frame started only to answer its API: no page
	if (new URLSearchParams(location.search).has('headless')) {
		connect()
		return
	}
	const root = createRoot(document.getElementById('root')!)
	if (definition.pages !== undefined) {
		const pages: HubbyPage[] = definition.pages.map(p => ({ path: p.path, title: p.title, icon: p.icon, section: p.nav ? (p.nav.section ?? '') : undefined }))
		root.render(createElement(StrictMode, null, createElement(PagesRouter, { definition })))
		connect()
		register(pages, definition.navSections ?? {})
		return
	}
	root.render(createElement(StrictMode, null, createElement(ManifestRoot, { definition })))
	connect()
}
