import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { faVolumeHigh, faVolumeXmark } from '@fortawesome/free-solid-svg-icons'
import { logout } from '@core/auth/logout'
import { resetAuthState } from '@core/auth/authState'
import { useAudioMuted } from '@core/contexts/AudioMutedContext'
import { Brand, IconButton, useMediaQuery } from '@cxxi-lab/hubbyware-ui'
import { UserMenu } from '@core/layout/UserMenu'
import type { NavDomain } from '@core/layout/AppLayout'
import { hubbyCount, openNotifications, useNotifications } from '@core/notifications/notifications'
import { HUBBY_MANIFESTS, hubbyHomePath } from '@core/hubby/registry'
import { useUpdating } from '@core/hubby/updates'
import { UpdateVeil } from '@core/hubby/UpdateVeil'
import { platform } from '@platform'
import { CommandSheet } from '@core/layout/CommandSheet'
import { useDeveloperMode } from '@core/settings/developer'

/** Two taps on the logo within this delay (ms) open the console (phones). */
const DOUBLE_TAP_MS = 300

interface Props {
	domains: NavDomain[]
	activeDomainId: string | null
}

export function TopBar({ domains, activeDomainId }: Props) {
	// the hubby open (a domain that is a hubby): its settings in the menu
	const openHubby = HUBBY_MANIFESTS.find(m => m.id === activeDomainId) ?? null
	const notifications = useNotifications()
	const updating = useUpdating()
	const navigate = useNavigate()
	const location = useLocation()
	const muted = useAudioMuted()
	// the open hubby's tab kept in view (the tabs scroll on a narrow screen)
	const activeTab = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [activeDomainId])

	// Phones have no status bar: in developer mode, a double tap on the logo opens the console (a
	// single tap still goes home, once the second tap is no longer expected).
	const phone = useMediaQuery('(width < 40rem)')
	const developer = useDeveloperMode()
	const consoleTap = phone && developer
	const [consoleOpen, setConsoleOpen] = useState(false)
	const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(() => () => { if (pendingTap.current) clearTimeout(pendingTap.current) }, [])
	const onBrandClick = (e: MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault()
		if (pendingTap.current) {
			clearTimeout(pendingTap.current)
			pendingTap.current = null
			setConsoleOpen(true)
			return
		}
		pendingTap.current = setTimeout(() => {
			pendingTap.current = null
			navigate('/')
		}, DOUBLE_TAP_MS)
	}

	const handleDomainClick = (domain: NavDomain) => {
		const manifest = HUBBY_MANIFESTS.find(m => m.id === domain.id)
		const path = manifest ? hubbyHomePath(manifest) : `/${domain.id}`
		// Its tab again on the page it opens on: back to the start (e.g. Private's Browse, back to its site picker).
		navigate(path, location.pathname === path ? { state: { reset: Date.now() } } : undefined)
	}

	// Mouse wheels only scroll vertically: turn that into horizontal scrolling of the hubby strip.
	const handleNavWheel = (e: WheelEvent<HTMLElement>) => {
		if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
		e.currentTarget.scrollLeft += e.deltaY
	}

	const handleLogout = async () => {
		await logout()
		await resetAuthState()
	}

	return (
		// One row: brand, hubbies (not on phones), controls.
		<header className="relative grid grid-cols-[auto_1fr_auto] max-sm:grid-cols-[auto_1fr] shrink-0 bg-steel-950 border-b border-steel-700">
			<div className="flex items-center h-14 pl-4">
				<Brand to="/" onClick={consoleTap ? onBrandClick : undefined} />
				{consoleTap && <CommandSheet open={consoleOpen} onClose={() => setConsoleOpen(false)} />}
			</div>

			{/* Hubby strip (desktop: phones reach the hubbies from the home page), scrolling horizontally. */}
			{!phone && (
			<nav
				onWheel={handleNavWheel}
				className={[
					'ml-2 flex min-w-0 h-14 text-sm/[2] overflow-x-auto overflow-y-hidden',
					'[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
					'[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]'
				].join(' ')}
			>
				{domains.map(domain => {
					const active = domain.id === activeDomainId
					// updating: can't be opened, the veil over its tab
					const update = updating.get(domain.id)
					// its dot: it has notifications (a hubby that supports them)
					const count = HUBBY_MANIFESTS.find(m => m.id === domain.id)?.supports?.includes('notifications')
						? hubbyCount(notifications, domain.id)
						: 0
					return (
						<button
							key={domain.id}
							ref={active ? activeTab : undefined}
							type="button"
							onClick={() => { if (!update) handleDomainClick(domain) }}
							disabled={!!update}
							title={update ? 'Updating…' : undefined}
							className={[
								'relative shrink-0 flex flex-col items-center justify-center mx-1 bg-transparent border-0 whitespace-nowrap',
								update ? 'cursor-default' : 'cursor-pointer',
								active
									? 'after:absolute after:bottom-0 after:inset-x-1 after:h-[3px] after:bg-primary-500 after:rounded-t-[1px]'
									: ''
							].join(' ')}
						>
							<div className={`relative flex items-center rounded-xs px-1 ${update ? '' : 'hover:bg-steel-700'}`}>
								<span className="mx-1 text-steel-100">{domain.label}</span>
								{update && <UpdateVeil updating={update} />}
								{count > 0 && (
									<span
										role="button"
										tabIndex={0}
										title={`${count} notification${count === 1 ? '' : 's'}`}
										onClick={e => { e.stopPropagation(); openNotifications(domain.id) }}
										onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openNotifications(domain.id) } }}
										className="group -ml-0.5 mr-0.5 p-1 flex items-center cursor-pointer"
									>
										{/* a dot (the count is on the bell); the padding makes it easier to hit */}
										<span className="size-2 rounded-full bg-primary-500 group-hover:bg-primary-300" />
									</span>
								)}
							</div>
						</button>
					)
				})}
				{/* Room past the last hubby, so it clears the fade once scrolled to the end. */}
				<span aria-hidden className="shrink-0 w-8" />
			</nav>
			)}

			<div className="ml-3 pr-4 flex items-center justify-end gap-3 h-14 max-sm:col-start-2 max-sm:row-start-1">
				{/* Not offered on phone-sized screens either (no use there, and room is short). */}
				{platform.capabilities.mute && !phone && (
					<IconButton
						size="xl"
						shape="circle"
						color="dark"
						icon={muted ? faVolumeXmark : faVolumeHigh}
						onClick={() => platform.setMuted(!muted)}
						highlighted={!muted}
						title={muted ? 'Unmute app' : 'Mute app'}
						aria-label={muted ? 'Unmute app' : 'Mute app'}
					/>
				)}

				<UserMenu
					hubby={openHubby ? { label: openHubby.label, onSettings: () => navigate(`/hubbies/${openHubby.id}`) } : null}
					onHubbies={() => navigate('/hubbies')}
					onDevices={() => navigate('/devices')}
					onSettings={() => platform.openSettings()}
					onLogout={handleLogout}
				/>
			</div>
		</header>
	)
}
