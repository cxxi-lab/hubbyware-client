import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCube, faEllipsis, faMagnifyingGlass, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { useMediaQuery } from '@cxxi-lab/hubbyware-ui'
import type { NavItem } from '@core/layout/AppLayout'
import { BottomBar, type BottomBarTab } from '@core/layout/BottomBar'

const linkClass = ({ isActive }: { isActive: boolean }) => [
	'block relative py-2 pl-8 pr-10 text-sm/[1] no-underline transition truncate',
	isActive
		? 'text-primary-500 bg-primary-700 before:absolute before:bg-primary-500 before:w-1 before:left-0 before:inset-y-0'
		: 'text-steel-100 hover:text-white hover:bg-steel-700'
].join(' ')

/** At most this many tabs in the bottom bar: the rest go under "More". */
const MAX_TABS = 5

/** An action after the pages (e.g. "Add a hubby"): a link under them, a tab on phones. */
export interface NavAction {
	label: string
	icon: IconDefinition
	onClick: () => void
}

/** A tab of the bottom bar: a page, a section (its pages in a menu), or the action. */
type Tab =
	| { kind: 'item', key: string, label: string, icon: IconDefinition, item: NavItem }
	| { kind: 'menu', key: string, label: string, icon: IconDefinition, groups: { title?: string, items: NavItem[] }[] }
	| { kind: 'action', key: string, label: string, icon: IconDefinition, onClick: () => void }

/** Consecutive items of a section make one block. */
function blocksOf(items: NavItem[]): { section?: string, items: NavItem[] }[] {
	const blocks: { section?: string, items: NavItem[] }[] = []
	for (const item of items) {
		const last = blocks[blocks.length - 1]
		if (last && last.section === item.section) last.items.push(item)
		else blocks.push({ section: item.section, items: [item] })
	}
	return blocks
}

function isActive(item: NavItem, pathname: string): boolean {
	return pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`))
}

/**
 * The bottom bar's tabs: a section of several pages is one tab opening them in a menu, a page
 * alone (or outside any section) is a tab of its own; a hubby with a single section shows its
 * pages as tabs. Past MAX_TABS, the last ones go under "More".
 */
function tabsOf(items: NavItem[], hubbyIcon: IconDefinition, sections: Record<string, IconDefinition>, action?: NavAction): Tab[] {
	const blocks = blocksOf(items)
	const single = blocks.length === 1
	const itemTab = (item: NavItem): Tab => ({
		kind: 'item',
		key: item.to,
		label: item.label,
		icon: item.icon ?? (item.section ? sections[item.section] : undefined) ?? hubbyIcon,
		item
	})
	const tabs: Tab[] = blocks.flatMap(block => !block.section || single || block.items.length === 1
		? block.items.map(itemTab)
		: [{ kind: 'menu' as const, key: `section:${block.section}`, label: block.section, icon: sections[block.section] ?? hubbyIcon, groups: [{ items: block.items }] }])
	const last: Tab[] = action ? [{ kind: 'action', key: 'action', label: action.label, icon: action.icon, onClick: action.onClick }] : []
	if (tabs.length + last.length <= MAX_TABS) return [...tabs, ...last]

	// past MAX_TABS: the first pages, "More" with the others, the action last
	const keep = MAX_TABS - 1 - last.length
	const groups = tabs.slice(keep).map(t => t.kind === 'menu' ? { title: t.label, items: t.groups.flatMap(g => g.items) } : { items: t.kind === 'item' ? [t.item] : [] })
	return [...tabs.slice(0, keep), { kind: 'menu', key: 'more', label: 'More', icon: faEllipsis, groups }, ...last]
}

/**
 * The active hubby's pages: a column left of the content on desktop; on phone-sized screens a
 * bar under the content, like Android's (nothing to drag from the screen's edge, which is the
 * system's back gesture).
 */
export function HubbyNav({ items: all, icon, sections, action, search }: {
	items: NavItem[]
	/** the hubby's icon: the tabs' default */
	icon?: IconDefinition
	/** the icons of the sections, by title */
	sections?: Record<string, IconDefinition>
	action?: NavAction
	/** a search field over the live items (its placeholder) */
	search?: string
}) {
	const phone = useMediaQuery('(width < 40rem)')
	const [query, setQuery] = useState('')
	const q = query.trim().toLowerCase()
	// a phone's bottom bar: the pages only (the live items are the hubby's page's there)
	const items = phone ? all.filter(i => !i.live) : all.filter(i => !i.live || !q || i.label.toLowerCase().includes(q))
	const { pathname } = useLocation()
	const navigate = useNavigate()

	if (phone) {
		const entry = (item: NavItem) => ({
			key: item.to, label: item.label, Label: item.Label, icon: item.icon,
			active: isActive(item, pathname), onClick: () => navigate(item.to)
		})
		// the hubby lays its bar out itself (a page's `phone`): its pages in their order, flat
		if (items.some(i => i.phone)) {
			const laid: BottomBarTab[] = items.filter(i => i.phone !== 'hidden').map(item => ({
				key: item.to,
				label: item.label,
				icon: item.icon ?? (item.section ? sections?.[item.section] : undefined) ?? icon ?? faCube,
				active: isActive(item, pathname),
				onClick: () => navigate(item.to),
				primary: item.phone === 'primary'
			}))
			return <BottomBar tabs={laid} />
		}
		const tabs: BottomBarTab[] = tabsOf(items, icon ?? faCube, sections ?? {}, action).map(tab =>
			tab.kind === 'item' ? { key: tab.key, label: tab.label, icon: tab.icon, active: isActive(tab.item, pathname), onClick: () => navigate(tab.item.to) }
			: tab.kind === 'action' ? { key: tab.key, label: tab.label, icon: tab.icon, active: false, onClick: tab.onClick }
			: { key: tab.key, label: tab.label, icon: tab.icon, fixed: tab.key === 'more', menu: tab.groups.map(g => ({ title: g.title, entries: g.items.map(entry) })) })
		return <BottomBar tabs={tabs} />
	}

	return (
		<aside className="w-64 shrink-0 flex flex-col py-4 bg-steel-900 border-r border-steel-700 min-h-0 overflow-y-auto">
			{/* a live navigation (a hubby's conversations…): its action and its search first, above a long list */}
			{search !== undefined && action && (
				<button type="button" onClick={action.onClick} className="mx-6 mb-3 flex items-center justify-center gap-2 rounded bg-primary-500 hover:bg-primary-300 px-3 py-2 text-sm font-semibold text-steel-950 border-0 cursor-pointer">
					<FontAwesomeIcon icon={action.icon} />
					{action.label}
				</button>
			)}
			{search !== undefined && (
				<label className="mx-6 mb-4 flex items-center gap-2 rounded bg-steel-800 px-2.5 py-1.5 text-steel-300">
					<FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs" />
					<input value={query} onChange={e => setQuery(e.target.value)} placeholder={search} className="flex-1 min-w-0 bg-transparent text-sm text-white outline-none" />
				</label>
			)}
			<nav className="flex flex-col gap-5">
				{blocksOf(items).map((block, i) => (
					<div key={block.section ?? i} className="flex flex-col">
						{block.section && (
							<div className="px-8 mb-2 text-[10px] font-bold uppercase tracking-[1.5px] text-steel-500">{block.section}</div>
						)}
						{block.items.map(({ to, label, Label, end }) => (
							<NavLink key={to} to={to} end={end} className={linkClass}>
								{Label ? <Label /> : label}
							</NavLink>
						))}
					</div>
				))}
				{action && search === undefined && (
					<button
						type="button"
						onClick={action.onClick}
						className="mx-8 flex items-center gap-2 text-xs text-white hover:text-primary-500 bg-transparent border-0 cursor-pointer p-0"
					>
						<FontAwesomeIcon icon={action.icon} />
						{action.label}
					</button>
				)}
			</nav>
		</aside>
	)
}
