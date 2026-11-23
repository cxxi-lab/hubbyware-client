/**
 * The messages between the app (host) and a hubby's frame (guest), both ways over postMessage.
 * (docs/plan-hubby-architecture.md § 4, 4 ter): the guest runs in a sandboxed iframe with an
 * opaque origin; it never gets a token, the host makes the API calls for it, within its scopes.
 */

/** A page of the hubby, as it announces it (its navigation is built by the host). */
export interface HubbyPage {
	/** relative to the hubby ('/', '/:id'…) */
	path: string
	title?: string
	/** a FontAwesome icon definition (plain data) */
	icon?: unknown
	/** in the navigation, under this section (no title: not in the navigation) */
	section?: string
}

/** A task of the hubby (server docs/plan-tasks.md), as its frame hears it. */
export interface TaskState {
	id: string
	operation: string
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
	progress: { done: number, total: number | null, message: string | null, data?: unknown } | null
	httpStatus: number | null
	error: string | null
	createdAt: string
	startedAt: string | null
	finishedAt: string | null
}

/** What the app tells a frame of its own state (pushed at start, then at each change). */
export interface AppState {
	phone: boolean
	/** the app's private mode (its hidden hubbies revealed) */
	privateMode: boolean
	/** this hubby shown (not hidden by its Privacy, or revealed) */
	visible: boolean
	/** this hubby's amounts blurred (its Privacy) */
	amountsBlurred: boolean
	/** bumped when the blurred amounts shown are hidden again (Ctrl+Alt+Q, a page left) */
	blurEpoch: number
	/** the VPN tunnel ready for this hubby (true when it doesn't go out through it) */
	tunnelReady: boolean
}

/** What a web surface tells its frame (the names of the webview's events it stands for). */
export type SurfaceEvent = 'dom-ready' | 'did-navigate' | 'did-navigate-in-page' | 'page-favicon-updated' | 'console-message' | 'did-fail-load'

/**
 * A web surface as the frame asks for it (docs/plan-isolation.md D3): a webview the host shows over
 * the frame, at `rect` (the frame's coordinates; null: not shown), in the hubby's partition.
 */
export interface SurfaceState {
	rect: { x: number, y: number, width: number, height: number } | null
	src: string
	referrer: string | null
	userAgent: string | null
	webPreferences: string | null
	/** kept loaded but not shown (something of the frame is over it) */
	covered: boolean
}

/** A failed call, as the frame rebuilds it (an ApiError when it has a status). */
export interface CallError {
	message: string
	status?: number
	detail?: string | null
}

/** Guest → host. */
export type GuestMessage =
	| { type: 'ready', at: number }
	| { type: 'register', pages: HubbyPage[], sections: Record<string, unknown> }
	| { type: 'call', id: number, method: string, args: unknown[] }
	| { type: 'back-depth', depth: number }
	| { type: 'key', key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }
	| { type: 'navigate', path: string }
	/**
	 * its live navigation (`nav.setItems`): links after its pages in the app's column (paths of its
	 * own), an action (New chat: `nav-action` when clicked), a search field over them
	 */
	| { type: 'nav', items: Array<{ path: string, label: string, section?: string }>, action?: { label: string } | null, search?: string | null }
	/** the answer to a `serve` (its id): what one of its API's methods gave, or why it failed */
	| { type: 'served', id: number, ok: true, value: unknown }
	| { type: 'served', id: number, ok: false, error: string }

/** Host → guest. */
export type HostMessage =
	/** `theme`, `accent`: the app's (a host from before themes sends none: dark, blue) */
	| { type: 'init', hubby: string, path: string, phone: boolean, scopes: string[], theme?: 'light' | 'dark', accent?: string, apiBase?: string, storage?: Record<string, string> }
	| { type: 'result', id: number, ok: true, value: unknown }
	| { type: 'result', id: number, ok: false, error: string, failure?: CallError }
	| { type: 'back' }
	| { type: 'path', path: string }
	/** the app's window got the focus back (a hubby refreshing then hears its window's `focus`) */
	| { type: 'focus' }
	/** the app's theme or accent changed */
	| { type: 'theme', theme: 'light' | 'dark', accent?: string }
	/** a task the frame follows changed (`tasks.follow`): its state */
	| { type: 'task', task: TaskState }
	/** the app's state, for this hubby (at start, then at each change) */
	| { type: 'state', state: AppState }
	/** an event of a stream the frame opened (`stream.open`, its id) */
	| { type: 'stream', stream: number, event: string, data: unknown }
	/** a document of one of its collections changed (another window, another device) */
	| { type: 'changed', collection: string, doc: string }
	/** the native player (Android) said something: `ready`, `closed`, `action` (its id), `navigate` (prev/next) */
	| { type: 'player', event: 'ready' | 'closed' | 'action' | 'navigate', value?: string }
	/** an event of one of its web surfaces (the webview the host shows for it) */
	| { type: 'surface', surface: number, event: SurfaceEvent, detail: Record<string, unknown> }
	/** its live navigation's action was clicked */
	| { type: 'nav-action' }
	/**
	 * Another hubby (`from`) calls a method of this hubby's API (docs/plan-api-hubbies.md): its input
	 * checked against its api.json; the frame answers with `served` (same id)
	 */
	| { type: 'serve', id: number, method: string, input: unknown, from: string }

export const PROTOCOL = 'hubby/1'

export interface Envelope<M> {
	protocol: typeof PROTOCOL
	message: M
}
