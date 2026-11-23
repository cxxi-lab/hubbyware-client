import { useSyncExternalStore } from 'react'
import type { NavItem } from '@core/layout/AppLayout'
import type { HubbyPage } from '@cxxi-lab/hubbyware-sdk/protocol'

/**
 * The navigation of the isolated hubbies, as each one's frame announced it (its `register`): the
 * host builds the column / bottom bar from it like a hubby's own. Besides its pages, a frame may set
 * a live part (`nav.setItems`: the AI hubby's conversations), again at any time: after its pages in
 * the column, searchable, with an action (New chat); not in a phone's bottom bar (the hubby shows
 * them in its page there).
 */

export interface LiveNav {
	items: NavItem[]
	action?: { label: string, onClick: () => void }
	/** a search field over its items (its placeholder) */
	search?: string
}

let navs: Record<string, { items: NavItem[], sections: Record<string, unknown>, live?: LiveNav }> = {}

const reselected = new Set<(path: string) => void>()

/** A page of a hubby's navigation tapped while already on it (a phone's bottom bar): told to its frame. */
export function reselectPage(path: string): void {
	reselected.forEach(l => l(path))
}

/** Heard by a hubby's host (its frame told when one of its pages is reselected). */
export function onPageReselect(listener: (path: string) => void): () => void {
	reselected.add(listener)
	return () => { reselected.delete(listener) }
}
const listeners = new Set<() => void>()

export function setHubbyNav(hubby: string, pages: HubbyPage[], sections: Record<string, unknown>): void {
	const items: NavItem[] = pages.filter(p => p.section !== undefined).map(p => ({
		to: `/${hubby}${p.path === '/' ? '' : p.path}`,
		label: p.title ?? p.path,
		section: p.section || undefined,
		icon: p.icon as NavItem['icon'],
		...(p.phone === 'tab' || p.phone === 'primary' || p.phone === 'hidden' ? { phone: p.phone } : {}),
		end: true
	}))
	navs = { ...navs, [hubby]: { items, sections, live: navs[hubby]?.live } }
	listeners.forEach(l => l())
}

/** A hubby's live navigation (null: none, e.g. its frame went away). */
export function setHubbyLiveNav(hubby: string, live: LiveNav | null): void {
	const current = navs[hubby] ?? { items: [], sections: {} }
	if (!live && !current.live) return
	navs = { ...navs, [hubby]: { ...current, live: live ?? undefined } }
	listeners.forEach(l => l())
}

export function useHubbyNavs() {
	return useSyncExternalStore(
		l => { listeners.add(l); return () => listeners.delete(l) },
		() => navs
	)
}
