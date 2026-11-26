import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faCube, faGear, faMagnifyingGlass, faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons'
import { announceHubbiesChange, fetchHubbiesState, setEnabledModules, setPinnedModules, updateHubbies, type HubbiesState } from '@core/api/hubbies'
import { INSTALLS, isInstalled, HUBBY_MANIFESTS, HUBBY_VERSIONS, uninstallHubby, useRegistry } from '@core/hubby/registry'
import type { HubbyManifest } from '@core/hubby/types'
import { allHubbies, enabledIds } from '@core/hubby/visibility'
import { ConfirmationModal, Modal } from '@cxxi-lab/hubbyware-ui'
import { NotificationsSettings } from '@core/hubbies/common/NotificationsSettings'
import { PrivacySettings } from '@core/hubbies/common/PrivacySettings'
import { PinSettings } from '@core/hubbies/common/PinSettings'
import { PermissionsSettings } from '@core/hubbies/common/PermissionsSettings'
import { VpnSettings } from '@core/hubbies/common/VpnSettings'
import { grantScopes, missingScopes, useHubbyScopes } from '@core/hubbies/scopes'
import { useRevealedHubbies } from '@core/privacy/hidden'
import { platform } from '@platform'
import { HomeScreenSettings } from '@core/hubbies/common/HomeScreenSettings'

/**
 * The hubbies screen (top-right menu > Hubbies), its pages in a sidebar (AppLayout):
 *  - /hubbies: Installed, the enabled hubbies as cards in their order (grab one to move it),
 *    filtered by the search; Uninstall disables one.
 *    Enabled ones make the home page, pinned ones the top bar too; a disabled hubby is out of the
 *    app and the server. Every change is saved at once and announced to the app (the top bar, the
 *    home page follow);
 *  - /hubbies?add: the others, to add (sidebar > Add a hubby): enabling a hubby this device
 *    doesn't have installs it;
 *  - /hubbies/<id>: a hubby's own settings.
 */
export function HubbiesPage() {
	return (
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div className="px-10 py-8 max-sm:px-4 max-sm:py-6">
				<HubbiesScreen />
			</div>
		</div>
	)
}

function HubbiesScreen() {
	const location = useLocation()
	const navigate = useNavigate()
	const [state, setState] = useState<HubbiesState | null>(null)
	const scopes = useHubbyScopes()
	/** a hubby waiting for its scopes to be allowed before being added */
	const [consent, setConsent] = useState<string | null>(null)
	const revealed = useRevealedHubbies()
	const [error, setError] = useState<string | null>(null)
	const [dragged, setDragged] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [params, setParams] = useSearchParams()
	const adding = params.has('add')
	/** the hubby whose settings screen is open (/hubbies/<id>) */
	const sub = location.pathname.split('/')[2]
	const opened = sub ?? null
	const setOpened = (id: string | null) => navigate(id ? `/hubbies/${id}` : '/hubbies')

	useEffect(() => {
		fetchHubbiesState().then(setState).catch(err => {
			console.error('[settings:hubbies] fetch failed', err)
			setError('Failed to load the hubbies')
		})
	}, [])

	const registry = useRegistry()
	const hubbies = useMemo(() => state ? allHubbies(state, revealed) : [], [state, revealed, registry])

	const byId = useMemo(() => new Map(hubbies.map(m => [m.id, m])), [hubbies])

	if (!state) {
		return (
			<>
				<h1 className="text-xl font-semibold text-white mb-6">Installed</h1>
				<div className="text-sm text-steel-300">{error ?? 'Loading…'}</div>
			</>
		)
	}

	// Hubbies not listed here (hidden ones not revealed…) keep their place and their state.
	const stored = enabledIds(state)
	const enabled = stored.filter(id => byId.has(id))
	const disabled = hubbies.filter(m => !enabled.includes(m.id))
	// requirements (`requires`) not enabled: the hubby stays off until they are
	const needs = (m: HubbyManifest) => (m.requires ?? [])
		.filter(id => !enabled.includes(id))
		.map(id => byId.get(id)?.label ?? id)

	const persist = (optimistic: HubbiesState, request: Promise<HubbiesState>) => {
		const previous = state
		setState(optimistic)
		setError(null)
		request
			.then(saved => {
				setState(saved)
				announceHubbiesChange(saved)
			})
			.catch(err => {
				console.error('[settings:hubbies] save failed', err)
				setState(previous)
				setError('Save failed')
			})
	}

	const save = (next: string[]) => persist({ ...state, enabled: next }, setEnabledModules(next))
	const hidden = stored.filter(id => !enabled.includes(id))

	/** Moves an enabled hubby to the place of another one. */
	const move = (id: string, to: number) => {
		const order = enabled.filter(e => e !== id)
		order.splice(Math.max(0, Math.min(to, order.length)), 0, id)
		save([...order, ...hidden])
	}
	/** Adds a hubby (enabled and pinned: unpinned from the home page) or removes it. */
	const toggle = (id: string, on: boolean) => {
		const next = on ? [...enabled, id, ...hidden] : [...enabled.filter(e => e !== id), ...hidden]
		const pinned = on ? [...state.pinned.filter(p => p !== id), id] : state.pinned.filter(p => p !== id)
		persist({ ...state, enabled: next, pinned }, updateHubbies({ enabled: next, pinned }))
	}

	/** Pins a hubby to the top bar or unpins it (its settings). */
	const pin = (id: string, on: boolean) => {
		const pinned = on ? [...state.pinned.filter(p => p !== id), id] : state.pinned.filter(p => p !== id)
		persist({ ...state, pinned }, setPinnedModules(pinned))
	}

	// a hidden hubby's settings too, when asked by name (/settings <hubby>): the way back to its
	// shortcut when it is forgotten
	const openedHubby = opened ? byId.get(opened) ?? HUBBY_MANIFESTS.find(m => m.id === opened) : undefined
	if (openedHubby) {
		const isEnabled = enabled.includes(openedHubby.id)
		const removable = !!platform.hubbyStore && isInstalled(openedHubby) && !isEnabled
		return (
			<HubbySettings
				hubby={openedHubby}
				removable={removable}
				pinned={isEnabled ? state.pinned.includes(openedHubby.id) : undefined}
				onPin={on => pin(openedHubby.id, on)}
				onUninstall={isEnabled ? () => { toggle(openedHubby.id, false); setOpened(null) } : undefined}
				onBack={() => setOpened(null)}
			/>
		)
	}

	const onDrop = (e: DragEvent, index: number) => {
		e.preventDefault()
		if (dragged) move(dragged, index)
		setDragged(null)
	}

	const needle = query.trim().toLowerCase()
	const matches = (m: HubbyManifest) => !needle
		|| m.label.toLowerCase().includes(needle)
		|| (m.description ?? '').toLowerCase().includes(needle)
	const shownEnabled = enabled.filter(id => matches(byId.get(id)!))
	// the order is the whole list's: no dragging while it is filtered
	const sortable = !needle

	return (
		<div className="flex flex-col gap-8">
			<div className="flex items-center gap-4 flex-wrap">
				<h1 className="m-0 text-xl font-semibold text-white">Installed</h1>
				<div className="relative ml-auto w-72 max-sm:ml-0 max-sm:basis-full">
					<FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-steel-300 text-xs" />
					<input
						type="search"
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="Search a hubby"
						className="w-full h-9 pl-8 pr-2 bg-steel-950 border border-steel-700 rounded text-sm text-steel-100 placeholder:text-steel-500 focus:outline-none focus:border-primary-500"
					/>
				</div>
			</div>

			<section className="flex flex-col gap-3">
				<p className="m-0 text-xs text-steel-300">Your hubbies, in their home page order. Drag a card to move it; click it to open its settings, where it can be uninstalled.</p>
				{needle && shownEnabled.length === 0 ? (
					<p className="m-0 text-sm text-steel-300">No installed hubby matches.</p>
				) : (
					<ol className="m-0 p-0 list-none grid grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))] gap-6">
						{shownEnabled.map(id => {
							const m = byId.get(id)!
							const i = enabled.indexOf(id)
							return (
								<li
									key={id}
									onDragOver={e => { if (dragged) e.preventDefault() }}
									onDrop={e => onDrop(e, i)}
									className={dragged === id ? 'opacity-40' : ''}
								>
									<InstalledCard
										hubby={m}
										missing={needs(m)}
										sortable={sortable}
										onDragStart={() => setDragged(id)}
										onDragEnd={() => setDragged(null)}
										onOpen={() => setOpened(id)}
									/>
								</li>
							)
						})}
						<li>
							<AddCard onClick={() => setParams({ add: '' })} />
						</li>
					</ol>
				)}
			</section>

			{adding && (
				<AddHubbies
					hubbies={disabled}
					needs={needs}
					onEnable={id => (missingScopes(scopes, id).length ? setConsent(id) : toggle(id, true))}
					onSettings={id => setOpened(id)}
					onClose={() => setParams({}, { replace: true })}
				/>
			)}

			{consent && (
				<ConfirmationModal
					title={`Allow ${byId.get(consent)?.label ?? consent}?`}
					confirmLabel="Allow and add"
					onConfirm={async () => {
						await grantScopes(consent, missingScopes(scopes, consent).map(s => s.scope))
						toggle(consent, true)
						setConsent(null)
					}}
					onClose={() => setConsent(null)}
				>
					<p className="m-0 mb-3 text-sm">It asks to:</p>
					<ul className="m-0 pl-5 flex flex-col gap-1 text-sm">
						{missingScopes(scopes, consent).map(s => <li key={s.scope}>{s.label}</li>)}
					</ul>
					<p className="m-0 mt-3 text-xs text-steel-400">You can take any of these back in its settings (Permissions).</p>
				</ConfirmationModal>
			)}

			{error && <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">{error}</div>}
		</div>
	)
}

/**
 * How well a hubby matches a search: its name starting with it, then a word of its name, then
 * anywhere in the name, then in the description; 0: not at all.
 */
function matchScore(m: HubbyManifest, needle: string): number {
	const label = m.label.toLowerCase()
	if (label.startsWith(needle)) return 4
	if (label.split(/\s+/).some(word => word.startsWith(needle))) return 3
	if (label.includes(needle)) return 2
	if ((m.description ?? '').toLowerCase().includes(needle)) return 1
	return 0
}

/**
 * The hubbies to add: every one not enabled, as cards (all of them, always); the search puts the
 * best matches first. A card adds its hubby (it leaves the grid, the modal stays open).
 */
function AddHubbies({ hubbies, needs, onEnable, onSettings, onClose }: {
	hubbies: HubbyManifest[]
	needs: (m: HubbyManifest) => string[]
	onEnable: (id: string) => void
	onSettings: (id: string) => void
	onClose: () => void
}) {
	const [query, setQuery] = useState('')
	const needle = query.trim().toLowerCase()
	// stable sort: equal scores keep the catalogue order
	const ranked = [...hubbies].sort((a, b) =>
		needle ? matchScore(b, needle) - matchScore(a, needle) : 0)

	return (
		<Modal title="Add a hubby" size="lg" onClose={onClose}>
			<div className="flex flex-col gap-4">
				<div className="relative">
					<FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-steel-300 text-xs" />
					<input
						type="search"
						autoFocus
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="Search a hubby"
						className="w-full h-9 pl-8 pr-2 bg-steel-950 border border-steel-700 rounded text-sm text-steel-100 placeholder:text-steel-500 focus:outline-none focus:border-primary-500"
					/>
				</div>
				{ranked.length === 0 ? (
					<p className="m-0 text-sm text-steel-300">Every hubby is enabled.</p>
				) : (
					<ul className="m-0 p-0 list-none grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-4">
						{ranked.map(m => (
							<li key={m.id}>
								<DisabledCard hubby={m} missing={needs(m)} onSettings={() => onSettings(m.id)} onEnable={() => onEnable(m.id)} />
							</li>
						))}
					</ul>
				)}
			</div>
		</Modal>
	)
}

/** A hubby to add, as a card (the home page's look): a click adds it; its settings from the gear. */
function DisabledCard({ hubby: m, missing, onSettings, onEnable }: {
	hubby: HubbyManifest
	missing: string[]
	onSettings: () => void
	onEnable: () => void
}) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onEnable}
			onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onEnable() } }}
			title={`Add ${m.label}`}
			className="h-full flex flex-col gap-3 p-4 rounded bg-steel-900 shadow-raised outline-none transition-shadow duration-200 cursor-pointer hover:shadow-raised-hover focus-visible:shadow-raised-focus"
		>
			<div className="flex items-start gap-3">
				<span className="size-10 shrink-0 flex items-center justify-center rounded bg-primary-500 text-steel-800">
					<FontAwesomeIcon icon={m.icon ?? faCube} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium text-white truncate">{m.label}</div>
					{!isInstalled(m) && <div className="text-[10px] uppercase tracking-[1.5px] text-steel-500">Not installed</div>}
					<p className="mt-1 mb-0 text-xs text-steel-300">
						{missing.length > 0
							? <span className="text-product-yellow">Needs {missing.join(', ')} enabled</span>
							: m.description}
					</p>
				</div>
				<span onClick={e => e.stopPropagation()}>
					<RowButton icon={faGear} label={`${m.label} settings`} onClick={onSettings} />
				</span>
			</div>
			{HUBBY_VERSIONS[m.id] && <div className="mt-auto text-xs text-steel-500 tabular-nums">v{HUBBY_VERSIONS[m.id]}</div>}
		</div>
	)
}

/**
 * One hubby's settings: the part every hubby has (its own values), then the hubby's own one
 * (its manifest's `Settings`).
 */
function HubbySettings({ hubby: m, removable, pinned, onPin, onUninstall, onBack }: {
	hubby: HubbyManifest
	removable: boolean
	/** an enabled hubby: whether it is pinned to the top bar */
	pinned?: boolean
	onPin: (on: boolean) => void
	/** an installed hubby: uninstalls it (disabled, on every device), confirmed first */
	onUninstall?: () => void
	onBack: () => void
}) {
	const Own = m.Settings
	const [confirming, setConfirming] = useState(false)
	const [removing, setRemoving] = useState<'idle' | 'busy' | string>('idle')
	const remove = () => {
		setRemoving('busy')
		uninstallHubby(m.id)
			.then(() => setRemoving('idle'))
			.catch(err => setRemoving(err instanceof Error ? err.message : String(err)))
	}
	return (
		<div className="flex flex-col gap-6 max-w-3xl">
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={onBack}
					title="Back to the installed hubbies"
					aria-label="Back"
					className="size-8 shrink-0 flex items-center justify-center rounded border-0 cursor-pointer bg-transparent text-steel-300 hover:text-white hover:bg-steel-700"
				>
					<FontAwesomeIcon icon={faArrowLeft} className="text-sm" />
				</button>
				<span className="size-9 shrink-0 flex items-center justify-center rounded bg-primary-500 text-steel-800">
					<FontAwesomeIcon icon={m.icon ?? faCube} />
				</span>
				<div className="min-w-0">
					<div className="text-xs text-steel-300">
						<button type="button" onClick={onBack} className="p-0 border-0 bg-transparent text-steel-300 hover:text-white cursor-pointer">Installed</button>
						<span className="mx-1.5 text-steel-500">›</span>
					</div>
					<h1 className="m-0 text-xl font-semibold text-white">{m.label}</h1>
				</div>
			</div>

			{/* the common part: one section per shared feature it supports */}
			{pinned !== undefined && <PinSettings hubby={m} pinned={pinned} onChange={onPin} />}
			{!m.local && isInstalled(m) && <PermissionsSettings hubby={m} />}
			{m.supports?.includes('notifications') && isInstalled(m) && <NotificationsSettings hubby={m} />}
			{m.supports?.includes('vpn') && platform.capabilities.vpn && isInstalled(m) && <VpnSettings hubby={m} />}
			{!m.local && <PrivacySettings hubby={m} />}
			{isInstalled(m) && <HomeScreenSettings hubby={m} />}

			{Own
				? <Own />
				: (
					<section className="bg-steel-900 border border-steel-700 rounded-md p-5">
						<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">{m.label}</h2>
						<p className="m-0 text-xs text-steel-300">
							{isInstalled(m) ? 'This hubby has no settings of its own.' : 'Not installed on this device: its settings come with it (enable it to install it).'}
						</p>
					</section>
				)}

			{removable && (
				<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex items-center gap-4">
					<div className="flex-1 min-w-0">
						<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">This device</h2>
						<p className="m-0 text-xs text-steel-300">
							Installed{HUBBY_VERSIONS[m.id] ? ` (v${HUBBY_VERSIONS[m.id]})` : ''} and disabled. Removing it frees its space; enabling it again downloads it.
						</p>
						{removing !== 'idle' && removing !== 'busy' && <p className="m-0 mt-1 text-xs text-red-300">{removing}</p>}
					</div>
					<button
						type="button"
						onClick={remove}
						disabled={removing === 'busy'}
						className="px-3 py-1.5 rounded border border-steel-600 bg-transparent text-xs text-steel-200 cursor-pointer hover:bg-steel-700 hover:text-white disabled:opacity-50 disabled:cursor-default"
					>
						{removing === 'busy' ? 'Removing…' : 'Remove from this device'}
					</button>
				</section>
			)}

			{onUninstall && (
				<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex items-center gap-4">
					<div className="flex-1 min-w-0">
						<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Uninstall</h2>
						<p className="m-0 text-xs text-steel-300">
							Takes {m.label} off the home page and the top bar, on every device. Its data stays: add it again to get it back.
						</p>
					</div>
					<button
						type="button"
						onClick={() => setConfirming(true)}
						className="flex items-center gap-2 px-3 py-1.5 rounded border border-red-500/50 bg-transparent text-xs text-red-300 cursor-pointer hover:bg-red-500/10"
					>
						<FontAwesomeIcon icon={faTrashCan} />
						Uninstall
					</button>
				</section>
			)}

			{confirming && onUninstall && (
				<ConfirmationModal
					title={`Uninstall ${m.label}?`}
					confirmLabel="Uninstall"
					confirmColor="danger"
					onConfirm={onUninstall}
					onClose={() => setConfirming(false)}
				>
					<p className="m-0 text-sm">
						It leaves the home page and the top bar, on every device. Its data stays: add it again
						from the sidebar to get it back.
					</p>
				</ConfirmationModal>
			)}
		</div>
	)
}

/** The grid's last card: opens Add a hubby, as the sidebar's link does. */
function AddCard({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full h-full min-h-32 flex flex-col items-center justify-center gap-2 p-4 rounded border border-dashed border-steel-700 bg-transparent text-sm text-steel-300 cursor-pointer outline-none transition hover:text-white hover:border-steel-500 hover:bg-steel-800 focus-visible:border-primary-500"
		>
			<FontAwesomeIcon icon={faPlus} className="text-xl" />
			Add a hubby
		</button>
	)
}

/**
 * An installed hubby, as a clickable card: a click opens its settings (where it is uninstalled), a
 * drag moves it in the grid; its install state, its version.
 */
function InstalledCard({ hubby: m, missing, sortable, onDragStart, onDragEnd, onOpen }: {
	hubby: HubbyManifest
	missing: string[]
	sortable: boolean
	onDragStart: () => void
	onDragEnd: () => void
	onOpen: () => void
}) {
	const install = INSTALLS.get(m.id)
	const status = isInstalled(m) ? null
		: install?.phase === 'installing' ? <span className="text-primary-500">Installing…</span>
		: install?.phase === 'error' ? <span className="text-red-300" title={install.error}>Install failed, retrying: {install.error}</span>
		: null
	return (
		<div
			role="link"
			tabIndex={0}
			draggable={sortable}
			onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
			onDragEnd={onDragEnd}
			onClick={onOpen}
			onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
			title={`${m.label} settings`}
			className="h-full flex flex-col gap-4 p-6 rounded bg-steel-800 text-steel-100 shadow-raised outline-none cursor-pointer transition-shadow duration-200 hover:shadow-raised-hover focus-visible:shadow-raised-focus"
		>
			<div className="flex items-start justify-between gap-3">
				<span className="size-12 shrink-0 flex items-center justify-center rounded bg-primary-500 text-steel-800">
					<FontAwesomeIcon icon={m.icon ?? faCube} className="text-xl" />
				</span>
				{HUBBY_VERSIONS[m.id] && <span className="text-xs text-steel-500 tabular-nums">v{HUBBY_VERSIONS[m.id]}</span>}
			</div>
			<div className="min-w-0">
				<h3 className="m-0 text-2xl font-medium text-white">{m.label}</h3>
				{!isInstalled(m) && <div className="text-[10px] uppercase tracking-[1.5px] text-steel-500">Not installed</div>}
				{(status ?? (missing.length > 0 || m.description)) && (
					<p className="mt-1 mb-0">
						{status ?? (missing.length > 0
							? <span className="text-product-yellow">Needs {missing.join(', ')} enabled</span>
							: m.description)}
					</p>
				)}
			</div>
		</div>
	)
}

function RowButton({ icon, label, onClick, disabled }: {
	icon: typeof faCube
	label: string
	onClick: () => void
	disabled?: boolean
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className="size-8 shrink-0 flex items-center justify-center rounded border-0 cursor-pointer transition-colors bg-transparent text-steel-300 hover:text-white hover:bg-steel-700 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-steel-300"
		>
			<FontAwesomeIcon icon={icon} className="text-xs" />
		</button>
	)
}

