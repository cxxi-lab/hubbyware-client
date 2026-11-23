import { api } from './client'

export interface HubbiesState {
	/** Hubby slugs the server can actually serve (registered HubbyInterface implementations). */
	available: string[]
	/**
	 * The user's enabled hubby slugs, in their top-bar order. null = all hubbies enabled, in the
	 * catalogue order (opt-out default).
	 */
	enabled: string[] | null
	/** The enabled hubbies also shown in the top bar (in the enabled order). */
	pinned: string[]
	/** The hubbies hidden behind a reveal shortcut (Privacy); absent: not read yet. */
	hidden?: string[]
	/** The hubbies locked by a password of their own (Privacy): their pages wait for it. */
	locked?: string[]
	/** among them, the ones locked by a PIN (asked on a keypad) */
	lockedByPin?: string[]
	/** The hubbies whose amounts are blurred (Privacy). */
	blurred?: string[]
}

export function fetchHubbiesState() {
	return api<{ data: HubbiesState }>('/api/hub/hubbies').then(r => r.data)
}

export function setEnabledModules(enabled: string[] | null) {
	return api<{ data: HubbiesState }>('/api/hub/hubbies', {
		method: 'PATCH',
		body: JSON.stringify({ enabled })
	}).then(r => r.data)
}

export function setPinnedModules(pinned: string[]) {
	return api<{ data: HubbiesState }>('/api/hub/hubbies', {
		method: 'PATCH',
		body: JSON.stringify({ pinned })
	}).then(r => r.data)
}

/** Both lists at once (adding a hubby enables and pins it). */
export function updateHubbies(patch: { enabled?: string[] | null, pinned?: string[] }) {
	return api<{ data: HubbiesState }>('/api/hub/hubbies', {
		method: 'PATCH',
		body: JSON.stringify(patch)
	}).then(r => r.data)
}

// A change of the hubbies (the Hubbies screen, a pin on the home page) is announced to the app's
// windows and pages (same origin): each one follows.
const CHANNEL = 'hub:modules'

export function announceHubbiesChange(state: HubbiesState) {
	try {
		const channel = new BroadcastChannel(CHANNEL)
		channel.postMessage(state)
		channel.close()
	}
	catch { /* no BroadcastChannel: the main window refetches when focused */ }
}

export function onHubbiesChange(cb: (state: HubbiesState) => void): () => void {
	try {
		const channel = new BroadcastChannel(CHANNEL)
		channel.onmessage = e => cb(e.data as HubbiesState)
		return () => channel.close()
	}
	catch {
		return () => {}
	}
}
