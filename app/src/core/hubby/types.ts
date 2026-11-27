import type { ComponentType, ReactNode } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { PlatformCapabilities } from '@platform'

export interface HubbyNavItem {
	to: string
	label: string
	/** optional live label (e.g. a name read at runtime + a badge), rendered instead of `label` */
	Label?: ComponentType
	/** the block of the sidebar it sits in, under this title (consecutive items share it) */
	section?: string
	/** its icon in the phone's bottom bar (default: its section's, then the hubby's) */
	icon?: IconDefinition
	/** the page the hubby opens on (default: the first item) */
	home?: boolean
}

export interface HubbyRoute {
	path: string
	Component: ComponentType
	/** kept mounted (KeepAlive) so page state survives navigation */
	persistent?: boolean
	/** also answers the paths under it (an isolated hubby: /<id>/… all go to its frame) */
	prefix?: boolean
}

/**
 * Desktop-side hubby manifest. The desktop owns the hubby catalogue (which hubbies
 * exist, their nav and pages); the server advertises which it can serve + which the
 * user enabled. `id` must match the server hubby slug (singular, e.g. 'workout').
 */
/**
 * A shared feature a hubby may support:
 *  - 'notifications': its notifications (the top bar's dot, the bell, its settings section);
 *  - 'vpn': the VPN tunnel, run only while the hubby is open (its pages wait for it);
 *  - 'amounts': it shows amounts (money…): its Privacy can blur them (the SDK's Amount).
 */
export type HubbySupport = 'notifications' | 'vpn' | 'amounts'

export interface HubbyManifest {
	id: string
	label: string
	/** its card on the home page */
	icon?: IconDefinition
	/** one line under its name on the home page */
	description?: string
	/** its own part of its settings screen (Hubbies > the hubby), under the common one */
	Settings?: ComponentType
	/**
	 * Runs entirely on this machine with no server counterpart: always shown, outside the
	 * server's enabled list and the front/server integrity diff.
	 */
	local?: boolean
	/**
	 * Host capabilities this hubby needs (see PlatformCapabilities). A shell that
	 * lacks any of them hides the hubby entirely — e.g. 'localAi' and 'webview'
	 * are desktop-only, so AI never appears in the mobile shell.
	 */
	requiresCapabilities?: Array<keyof PlatformCapabilities>
	navItems: HubbyNavItem[]
	/**
	 * Runs isolated, in a sandboxed frame (docs/plan-hubby-architecture.md § 4 ter): none of its
	 * code is loaded in the app; its navigation is the one its frame announces.
	 */
	isolated?: boolean
	/** the icons of its nav sections (by title): a section is a tab of the phone's bottom bar */
	navSections?: Record<string, IconDefinition>
	routes: HubbyRoute[]
	/**
	 * Hubbies this one cannot work without (ids): it is only active while they all are, and
	 * the Hubbies screen says so.
	 */
	requires?: string[]
	/**
	 * The shared features it supports (as its server hubby does): each brings its part of the
	 * hubby's settings and its plumbing in the app, e.g. 'notifications' (the top bar's badge).
	 */
	supports?: HubbySupport[]
	/**
	 * It works in the background (hubby.json `background`): a frame of its own kept running unseen
	 * while the app runs, on a desktop, once its scope app:background is granted (apis.ts).
	 */
	background?: boolean
	/**
	 * Contexts this hubby needs around the whole app while it is active (e.g. a job followed from
	 * any page), outermost first.
	 */
	providers?: Array<ComponentType<{ children: ReactNode }>>
}
