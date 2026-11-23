import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { faCube, faCubes, faPlus, faPuzzlePiece, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { hideAll, reveal, setBlurredHubbies, setHiddenHubbies, useHiddenHubbies, useRevealedHubbies } from '@core/privacy/hidden'
import { KeepAlive } from '@core/layout/KeepAlive'
import { TopBar } from '@core/layout/TopBar'
import { HubbyUpdates } from '@core/hubby/HubbyUpdates'
import { HubbyApiFrames } from '@core/hubby/HubbyApiFrames'
import { ModelConsent } from '@core/ai/ModelConsent'
import { AgentConfirm } from '@core/ai/AgentConfirm'
import { startAgentBridge } from '@core/ai/agentBridge'
import { startRemote } from '@core/ai/remote'
import { setAvailableHubbies } from '@core/hubby/apis'
import { useUpdating } from '@core/hubby/updates'
import { HubbyNav } from '@core/layout/HubbyNav'
import { useHubbyNavs } from '@core/hubby/navs'
import { installHubbies, HUBBY_MANIFESTS, useRegistry } from '@core/hubby/registry'
import type { HubbyManifest } from '@core/hubby/types'
import { enabledModules, wantedIds } from '@core/hubby/visibility'
import { fetchHubbiesState, onHubbiesChange, type HubbiesState } from '@core/api/hubbies'
import { HubbiesContext } from '@core/contexts/HubbiesContext'
import { HubbiesPage } from '@core/hubbies/HubbiesPage'
import { DevicesPage } from '@core/devices/DevicesPage'
import { SettingsPage } from '@core/settings/SettingsApp'
import { platform } from '@platform'
import { startNotifications } from '@core/notifications/notifications'
import { SystemNotifications } from '@core/notifications/SystemNotifications'
import { TunnelGate } from '@core/vpn/TunnelGate'
import { LockGate } from '@core/privacy/LockGate'

// Kept for TopBar's prop shape (built from the hubby manifests).
export interface NavItem {
	to: string; label: string; Label?: ComponentType; section?: string; home?: boolean; icon?: IconDefinition
	/** active on this path only, not on the ones under it */
	end?: boolean
	/** set by the hubby as it goes (its live navigation): not in a phone's bottom bar */
	live?: boolean
	/** on a phone's bottom bar: a tab, the round button in the middle, or not there (the hubby says) */
	phone?: 'tab' | 'primary' | 'hidden'
}
export interface NavDomain {
	id: string
	label: string
	requiresPrivate?: boolean
	items: NavItem[]
	icon?: IconDefinition
	sections?: Record<string, IconDefinition>
	/** its live navigation's action and search (core/hubby/navs.ts) */
	action?: { label: string, onClick: () => void }
	search?: string
}

// Always-present shell pages (not hubbies).
const CORE_SHELL_PAGES: { path: string; Component: ComponentType }[] = [
	{ path: '/hubbies', Component: HubbiesPage },
	{ path: '/devices', Component: DevicesPage },
	// the shells without a Settings window (Android): Settings as a page
	{ path: '/settings', Component: SettingsPage }
]
/** A shell page's path, or one of its screens (/hubbies/mail). */
const isCorePath = (pathname: string) => CORE_SHELL_PAGES.some(p => pathname === p.path || pathname.startsWith(`${p.path}/`))

/** a reveal shortcut is sent once no key came for this long (Ctrl+Alt still held or not) */
const SHORTCUT_PAUSE_MS = 900
const SHORTCUT_KEY = /^[a-z0-9]$/

export function AppLayout() {
	const location = useLocation()
	const navigate = useNavigate()
	const revealed = useRevealedHubbies()
	const hidden = useHiddenHubbies()

	// Desktop owns the hubby catalogue (manifests); the server advertises which hubbies
	// it can serve (`available`) and which the user enabled. Default = all enabled (null)
	// so the UI is populated before the fetch resolves.
	// (the hidden ones: as last read, so that none shows before the server answers)
	const [hubbies, setHubbies] = useState<HubbiesState>(() => ({ available: [], enabled: null, pinned: [], hidden }))

	useEffect(() => {
		if (hubbies.hidden) setHiddenHubbies(hubbies.hidden)
	}, [hubbies.hidden])

	useEffect(() => {
		if (hubbies.blurred) setBlurredHubbies(hubbies.blurred)
	}, [hubbies.blurred])

	// The notifications, kept live for the top bar and its menu.
	useEffect(() => startNotifications(), [])

	// Fetched at boot, then kept in step with the Settings window (announced changes, and a refetch
	// whenever this window comes back to the front).
	useEffect(() => {
		let alive = true
		const load = () => fetchHubbiesState()
			.then(state => { if (alive) setHubbies(state) })
			.catch(() => { /* keep what we have (optimistic defaults at boot) */ })
		load()
		const off = onHubbiesChange(state => { if (alive) setHubbies(state) })
		window.addEventListener('focus', load)
		return () => {
			alive = false
			off()
			window.removeEventListener('focus', load)
		}
	}, [])

	// Front/server integrity diff — guards against version skew (desktop auto-updates
	// while the server is deployed manually).
	useEffect(() => {
		if (hubbies.available.length === 0) return // server hasn't reported (or migration in progress)
		const frontIds = HUBBY_MANIFESTS.filter(m => !m.local).map(m => m.id)
		const frontOnly = frontIds.filter(id => !hubbies.available.includes(id))
		const serverOnly = hubbies.available.filter(id => !frontIds.includes(id))
		if (frontOnly.length) console.warn('[hubbies] manifest without server support — update the server:', frontOnly)
		if (serverOnly.length) console.warn('[hubbies] server hubby without a desktop manifest — update the desktop:', serverOnly)
	}, [hubbies])

	// The catalogue changes as hubbies get installed (and as the store lists the others).
	const registry = useRegistry()

	// Enabled hubbies in the user's order: the home page and the routes mounted (the top bar: the pinned ones).
	const visibleHubbies = useMemo(() => enabledModules(hubbies, revealed), [hubbies, revealed, registry])
	// the hubbies whose API may answer the others (docs/plan-api-hubbies.md): shown and unlocked
	const answering = visibleHubbies.map(m => m.id).filter(id => !(hubbies.locked ?? []).includes(id)).join(',')
	useEffect(() => { setAvailableHubbies(answering ? answering.split(',') : []) }, [answering])
	// a device agent's requests through Hubbyware's MCP server (desktop): answered here, as the assistant's
	useEffect(() => startAgentBridge(), [])
	// this device's presence and engines for the account's other devices, and the turns they ask it
	useEffect(() => startRemote(), [])

	// An enabled hubby this device doesn't have yet is installed, then shown (on every device).
	useEffect(() => {
		installHubbies(wantedIds(hubbies, revealed))
	}, [hubbies, revealed, registry])

	// The routes of the hidden hubbies not revealed: left at once (Ctrl+Alt+Q on one of their pages).
	const hiddenRoutes = useMemo(
		() => new Set(HUBBY_MANIFESTS.filter(m => (hubbies.hidden ?? []).includes(m.id) && !revealed.includes(m.id)).flatMap(m => m.routes.map(r => r.path))),
		[registry, hubbies.hidden, revealed]
	)

	// an isolated hubby's navigation: the one its frame announced
	const hubbyNavs = useHubbyNavs()
	const domains: NavDomain[] = useMemo(
		() => visibleHubbies.map(m => m.isolated
			? {
				id: m.id, label: m.label, icon: m.icon, sections: hubbyNavs[m.id]?.sections as NavDomain['sections'],
				items: [...(hubbyNavs[m.id]?.items ?? []), ...(hubbyNavs[m.id]?.live?.items ?? [])],
				action: hubbyNavs[m.id]?.live?.action, search: hubbyNavs[m.id]?.live?.search
			}
			: { id: m.id, label: m.label, items: m.navItems, icon: m.icon, sections: m.navSections }),
		[visibleHubbies, hubbyNavs]
	)


	const registeredPaths = useMemo(
		() => new Set([...CORE_SHELL_PAGES.map(p => p.path), ...visibleHubbies.flatMap(m => m.routes.map(r => r.path))]),
		[visibleHubbies]
	)

	const activeDomain = domains.find(d => {
		// Sub-pages (e.g. a conversation under its list) keep their domain active.
		// /<id>/… is always the hubby's (an isolated hubby's pages are all under it)
		if (location.pathname === `/${d.id}` || location.pathname.startsWith(`/${d.id}/`)) return true
		return d.items.some(i => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`))
	}) ?? null

	// The Hubbies screen's sidebar: its page, then a direct link to each enabled hubby's settings.
	const hubbiesNav: NavItem[] = useMemo(() => [
		{ to: '/hubbies', label: 'Installed', end: true, icon: faCubes },
		...visibleHubbies.map(m => ({ to: `/hubbies/${m.id}`, label: m.label, section: 'Hubbies', icon: m.icon ?? faCube }))
	], [visibleHubbies])
	const onHubbiesScreen = location.pathname === '/hubbies' || location.pathname.startsWith('/hubbies/')

	// The top bar: the pinned hubbies, plus the one open (its tab marks where you are).
	const topBarDomains = useMemo(
		() => domains.filter(d => hubbies.pinned.includes(d.id) || d.id === activeDomain?.id),
		[domains, hubbies.pinned, activeDomain?.id]
	)

	// A page of a hubby just disabled (or of none): back to the home page.
	useEffect(() => {
		if (location.pathname !== '/' && !activeDomain && !isCorePath(location.pathname)) navigate('/', { replace: true })
	}, [location.pathname, activeDomain, navigate])

	// a hubby updating can't be opened (its update shows on its icon): home meanwhile
	const updating = useUpdating()
	useEffect(() => {
		if (activeDomain && updating.has(activeDomain.id)) navigate('/', { replace: true })
	}, [activeDomain?.id, updating, navigate])

	useEffect(() => {
		if (hiddenRoutes.has(location.pathname)) {
			navigate('/', { replace: true })
		}
	}, [hiddenRoutes, location.pathname, navigate])

	// The reveal shortcuts: letters and digits typed with Ctrl+Alt held, sent to the server once
	// they stop (it alone knows the shortcuts); Ctrl+Alt+Q hides every revealed hubby again.
	useEffect(() => {
		let keys = ''
		let timer: ReturnType<typeof setTimeout> | null = null

		const send = () => {
			timer = null
			const typed = keys
			keys = ''
			if (typed.length >= 3) void reveal(typed).catch(err => console.warn('[privacy] reveal failed', err))
		}

		const handleKey = (rawKey: string, ctrl: boolean, alt: boolean): void => {
			if (!ctrl || !alt || rawKey === 'Control' || rawKey === 'Alt') return
			const key = rawKey.toLowerCase()
			if (key === 'q') {
				keys = ''
				if (timer) clearTimeout(timer)
				timer = null
				hideAll()
				return
			}
			if (!SHORTCUT_KEY.test(key)) return
			keys = (keys + key).slice(-16)
			if (timer) clearTimeout(timer)
			timer = setTimeout(send, SHORTCUT_PAUSE_MS)
		}

		const onKeyDown = (e: KeyboardEvent) => {
			handleKey(e.key, e.ctrlKey, e.altKey)
		}

		window.addEventListener('keydown', onKeyDown)
		const unsubWebview = platform.onWebviewKey(({ key, ctrl, alt }) => handleKey(key, ctrl, alt))

		return () => {
			window.removeEventListener('keydown', onKeyDown)
			if (timer) clearTimeout(timer)
			unsubWebview()
		}
	}, [])

	return (
		<HubbiesContext value={visibleHubbies}>
		<div className="flex flex-col h-[calc(100vh-var(--status-bar-height))]">
			<SystemNotifications />
			<TopBar domains={topBarDomains} activeDomainId={activeDomain?.id ?? null} />
			<HubbyUpdates activeHubby={activeDomain?.id ?? null} />
			<HubbyApiFrames />
			<ModelConsent />
			<AgentConfirm />
			{/* on phones the hubby nav is a bar under the content (column, the bar last) */}
			<div className="relative flex-1 flex max-sm:flex-col min-h-0 overflow-hidden">
				{/* its column: its pages, or its live navigation (its action shows it even before any item) */}
				{activeDomain && (activeDomain.items.length > 0 || activeDomain.action) && (
					<HubbyNav items={activeDomain.items} icon={activeDomain.icon} sections={activeDomain.sections}
						action={activeDomain.action ? { ...activeDomain.action, icon: faPlus } : undefined} search={activeDomain.search} />
				)}
				{onHubbiesScreen && (
					<HubbyNav
						items={hubbiesNav}
						icon={faCubes}
						sections={{ Hubbies: faPuzzlePiece }}
						action={{ label: 'Add a hubby', icon: faPlus, onClick: () => navigate({ pathname: '/hubbies', search: '?add' }) }}
					/>
				)}
				<main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
					{activeDomain && activeDomain.items.length === 0 && !registeredPaths.has(location.pathname) && !visibleHubbies.some(m => m.routes.some(r => routeMatches(r, location.pathname))) && (
						<div className="flex-1 flex items-center justify-center text-steel-300 text-sm">
							<span>{activeDomain.label} — coming soon</span>
						</div>
					)}
					{/* shell pages: mounted while shown (read afresh each visit) */}
					{CORE_SHELL_PAGES.map(({ path, Component }) => (
						(location.pathname === path || location.pathname.startsWith(`${path}/`)) && <Component key={path} />
					))}
					{visibleHubbies.map(m => (
						<HubbyPages key={m.id} hubby={m} pathname={location.pathname} locked={(hubbies.locked ?? []).includes(m.id)} pin={(hubbies.lockedByPin ?? []).includes(m.id)} />
					))}
					<Outlet />
				</main>
			</div>
		</div>
		</HubbiesContext>
	)
}

/**
 * A hubby's pages, inside the contexts it declared (`providers`, one instance shared by its pages):
 * persistent pages stay mounted once visited (KeepAlive), the others only while shown. Scoped per
 * hubby, a hubby coming or going (private mode) leaves the other hubbies' pages as they are.
 */
/** Does a route answer this path (its own, or one under it for a prefix route)? */
function routeMatches(route: HubbyManifest['routes'][number], pathname: string): boolean {
	return pathname === route.path || (!!route.prefix && pathname.startsWith(`${route.path}/`))
}

function HubbyPages({ hubby, pathname, locked, pin }: { hubby: HubbyManifest, pathname: string, locked: boolean, pin: boolean }) {
	const pages = hubby.routes.map(route => route.persistent
		? <KeepAlive key={route.path} when={routeMatches(route, pathname)}><route.Component /></KeepAlive>
		: routeMatches(route, pathname) ? <route.Component key={route.path} /> : null)
	const active = hubby.routes.some(r => routeMatches(r, pathname))
	// a hubby on the VPN: its pages behind the tunnel, run while it is open
	const tunneled = hubby.supports?.includes('vpn') && platform.capabilities.vpn
		? <TunnelGate hubby={hubby.id} active={active}>{pages}</TunnelGate>
		: <>{pages}</>
	// a locked one: behind its password first (nothing of it loads before)
	const content = locked
		? <LockGate hubby={hubby.id} label={hubby.label} active={active} pin={pin}>{tunneled}</LockGate>
		: tunneled
	return (hubby.providers ?? []).reduceRight<ReactNode>((inner, Provider) => <Provider>{inner}</Provider>, content)
}
