import type { ComponentType, ReactNode } from 'react'

// Types of the SDK's common API (docs/plan-isolation.md § 2) that the app's sources declare too
// (app/src/platform/types.ts, core/hubby/capabilities/timeline.ts, shared/apiResponse.ts): copied
// here, the SDK being the contract — keep them alike.

export type Unsubscribe = () => void

// --- the API's JSON envelopes ---

export interface SingleResponse<T> { data: T }
export interface ListResponse<T> { data: T[] }
/** Paginated list envelope (data + page metadata). */
export interface PaginatedResponse<T> {
	data: T[]
	meta: { page: number, limit: number, total: number, pages: number }
}

// --- a hubby's definition, in the form of a manifest ---

export interface HubbyNavItem {
	to: string
	label: string
	/** a live label (in the app only; a frame shows `label`) */
	Label?: ComponentType
	section?: string
	icon?: unknown
	home?: boolean
	/**
	 * on a phone's bottom bar: a tab, the round button in the middle (`primary`), or not there; as
	 * soon as one page says, the bar is its pages in their order (not grouped by section)
	 */
	phone?: 'tab' | 'primary' | 'hidden'
}

export interface HubbyRoute {
	path: string
	Component: ComponentType
	/** kept mounted once visited */
	persistent?: boolean
	/** also answers the paths under it */
	prefix?: boolean
}

/**
 * A hubby's definition (defineHubby), in the form of a manifest: its navigation and its pages; what
 * its hubby.json says (describe(info)) rides along, read by the host from its catalogue entry.
 */
export interface HubbyManifest {
	id: string
	label?: string
	description?: string
	icon?: unknown
	local?: boolean
	requires?: string[]
	requiresCapabilities?: string[]
	supports?: string[]
	navItems: HubbyNavItem[]
	navSections?: Record<string, unknown>
	routes: HubbyRoute[]
	/** contexts around all its pages, outermost first */
	providers?: Array<ComponentType<{ children: ReactNode }>>
	/** in the app only (a frame's settings are a page: hubby.json settingsPage) */
	Settings?: ComponentType
	/** in the app only (between isolated hubbies: their APIs, to come) */
	contributes?: Record<string, unknown>
	pages?: never
}

// --- Planner's calendar (a contribution, in the app only) ---

/** A dated item of a hubby (e.g. a workout session) a calendar shows. */
export interface TimelineItem {
	id: string
	date: Date
	title: string
	hubbyId: string
	href: string
	color?: string
	payload?: unknown
}

// --- the shell (app/src/platform/types.ts) ---

/** What the web layer hands the native player: desktop VideoPlayerModal's webview inputs. */
export interface NativePlayerOptions {
	url: string
	/** Referer header for the first load (embed mode), null for none */
	referrer: string | null
	/** script run once the DOM is ready; the player is ready when its promise settles (null: ready on load) */
	bootstrap: string | null
	/** shown while the page loads */
	poster: string | null
	/** swipe neighbours: whether there is one each way, and its poster (slides in while swiping) */
	hasPrev: boolean
	hasNext: boolean
	prevPoster: string | null
	nextPoster: string | null
	/** posters to fetch ahead (videos further away), so fast swipes find them ready */
	preloadPosters: string[]
}

/** A Font Awesome icon as drawn natively: viewBox size + SVG path data. */
export interface NativeIcon {
	width: number
	height: number
	path: string
}

/** One of the player's actions, behind its gear button. Taps come back through `onAction`. */
export interface NativePlayerAction {
	id: string
	label: string
	icon: NativeIcon
	/** danger: a destructive action awaiting its confirming second tap */
	tone: 'default' | 'danger'
	/** running: shown dimmed, taps ignored */
	busy: boolean
}

/** Overlay over the video (tags, info); tapping it closes it. */
export interface NativePlayerPanel {
	chips?: string[]
	rows?: Array<[label: string, value: string]>
}

/**
 * Fullscreen native player above the app (Capacitor). Stands in for the
 * <webview> of the video player modal on shells without `capabilities.webview`;
 * only reached when `capabilities.nativePlayer` is true.
 */
export interface NativePlayerApi {
	open(options: NativePlayerOptions): Promise<void>
	exec(script: string): Promise<void>
	reload(): Promise<void>
	close(): Promise<void>
	/** the actions behind the gear (the whole list each time), and the icons of the gear and close buttons */
	setActions(actions: NativePlayerAction[], icons: { menu: NativeIcon; close: NativeIcon }): Promise<void>
	showPanel(panel: NativePlayerPanel | null): Promise<void>
	onReady(cb: () => void): Unsubscribe
	onClosed(cb: () => void): Unsubscribe
	onAction(cb: (id: string) => void): Unsubscribe
	/** a swipe went through: the web side switches to that neighbour and opens it */
	onNavigate(cb: (direction: 'prev' | 'next') => void): Unsubscribe
}
