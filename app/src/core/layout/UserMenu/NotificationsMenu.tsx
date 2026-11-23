import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBell, faCube, faXmark } from '@fortawesome/free-solid-svg-icons'
import { IconButton, Dropdown } from '@cxxi-lab/hubbyware-ui'
import { useHubbies } from '@core/contexts/HubbiesContext'
import { dismissNotification, setLocalNotification, useLocalNotifications, useNotifications, useNotificationsOpening, type AppNotification, type LocalNotification } from '@core/notifications/notifications'
import { styles } from './UserMenu.variants'

/**
 * The bell (top right) and its menu: the notifications of the hubbies shown, newest first, then the
 * app's own (a hubby's update ready…). A click opens where one leads (an app's one: its action), its
 * cross dismisses it. A hubby's dot in the top bar opens it on that hubby's notifications.
 */
export function NotificationsMenu() {
	const navigate = useNavigate()
	const hubbies = useHubbies()
	const all = useNotifications()
	const opening = useNotificationsOpening()
	const [open, setOpen] = useState(false)
	const listRef = useRef<HTMLUListElement>(null)

	const byId = new Map(hubbies.map(m => [m.id, m]))
	const shown = all.filter(n => byId.get(n.module)?.supports?.includes('notifications'))
	// a hidden hubby's (its update…) stays hidden with it
	const locals = useLocalNotifications().filter(n => byId.has(n.hubby))
	const count = shown.length + locals.length

	// opened from a hubby's dot: on its first notification
	useEffect(() => {
		if (!opening) return
		setOpen(true)
		if (!opening.hubby) return
		const frame = requestAnimationFrame(() => {
			listRef.current?.querySelector<HTMLElement>(`[data-module="${opening.hubby}"]`)?.scrollIntoView({ block: 'nearest' })
		})
		return () => cancelAnimationFrame(frame)
	}, [opening])

	const go = (n: AppNotification) => {
		setOpen(false)
		if (n.link) navigate(n.link)
	}

	return (
		<Dropdown
			side="right"
			className={styles.phoneWide()}
			isOpen={open}
			onOpenChange={setOpen}
			header={isOpen => (
				<span className="relative flex">
					<IconButton size="xl" shape="circle" color="dark" active={isOpen} icon={faBell} aria-label="Notifications" />
					{/* a dot, no count */}
					{count > 0 && (
						<span className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-primary-500 pointer-events-none" />
					)}
				</span>
			)}
		>
			<div className="w-[340px] max-sm:w-full">
				{count === 0 ? (
					<div className="px-5 py-4 text-sm text-steel-300 text-center">No notifications</div>
				) : (
					<ul ref={listRef} className="m-0 p-0 list-none max-h-[60vh] overflow-y-auto pretty-scrollbar">
						{shown.map(n => {
							const hubby = byId.get(n.module)
							return (
								<li
									key={n.id}
									data-module={n.module}
									className={`flex items-start gap-3 px-4 py-3 border-t border-steel-700 first:border-t-0 ${n.link ? 'cursor-pointer hover:bg-steel-700' : ''}`}
									onClick={e => { e.stopPropagation(); go(n) }}
								>
									<span className="size-8 shrink-0 flex items-center justify-center rounded bg-primary-500 text-steel-800">
										<FontAwesomeIcon icon={hubby?.icon ?? faCube} className="text-sm" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex items-baseline gap-2">
											<span className="min-w-0 flex-1 truncate text-sm text-white">{n.title}</span>
											<span className="shrink-0 text-[11px] text-steel-500 tabular-nums">{when(n.updatedAt)}</span>
										</span>
										{n.body && <span className="block text-xs text-steel-300">{n.body}</span>}
										<span className="block text-[10px] uppercase tracking-[1.5px] text-steel-500">{hubby?.label ?? n.module}</span>
									</span>
									<button
										type="button"
										title="Dismiss"
										aria-label="Dismiss"
										onClick={e => { e.stopPropagation(); void dismissNotification(n.id) }}
										className="size-6 shrink-0 flex items-center justify-center rounded border-0 bg-transparent text-steel-300 cursor-pointer hover:text-white hover:bg-steel-900"
									>
										<FontAwesomeIcon icon={faXmark} className="text-xs" />
									</button>
								</li>
							)
						})}
						{locals.map(n => <LocalItem key={n.key} n={n} label={byId.get(n.hubby)?.label ?? n.hubby} icon={byId.get(n.hubby)?.icon} onRun={() => { setOpen(false); n.action() }} />)}
					</ul>
				)}
			</div>
		</Dropdown>
	)
}

/** One of the app's own notifications (not the server's): its click runs its action. */
function LocalItem({ n, label, icon, onRun }: { n: LocalNotification, label: string, icon?: AppIcon, onRun: () => void }) {
	return (
		<li
			data-module={n.hubby}
			className="flex items-start gap-3 px-4 py-3 border-t border-steel-700 first:border-t-0 cursor-pointer hover:bg-steel-700"
			onClick={e => { e.stopPropagation(); onRun() }}
		>
			<span className="size-8 shrink-0 flex items-center justify-center rounded bg-primary-500 text-steel-800">
				<FontAwesomeIcon icon={icon ?? faCube} className="text-sm" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate text-sm text-white">{n.title}</span>
					<span className="shrink-0 text-[11px] text-steel-500 tabular-nums">{when(n.createdAt)}</span>
				</span>
				{n.body && <span className="block text-xs text-steel-300">{n.body}</span>}
				<span className="block text-[10px] uppercase tracking-[1.5px] text-steel-500">{label}</span>
			</span>
			<button
				type="button"
				title="Dismiss"
				aria-label="Dismiss"
				onClick={e => { e.stopPropagation(); setLocalNotification(n.key, null) }}
				className="size-6 shrink-0 flex items-center justify-center rounded border-0 bg-transparent text-steel-300 cursor-pointer hover:text-white hover:bg-steel-900"
			>
				<FontAwesomeIcon icon={faXmark} className="text-xs" />
			</button>
		</li>
	)
}

type AppIcon = NonNullable<ReturnType<typeof useHubbies>[number]['icon']>

/** Its time: today's as hh:mm, else the day. */
function when(iso: string): string {
	const date = new Date(iso)
	const today = new Date()
	return date.toDateString() === today.toDateString()
		? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
