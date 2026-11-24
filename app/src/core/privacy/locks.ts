import { useSyncExternalStore } from 'react'
import { hubbyOfCapability } from '@core/hubby/declarations'

/**
 * The locked hubbies (Privacy: a password of their own). Their API answers 423 until the app sends
 * an unlock token (X-Hub-Unlock), given by the server against that password. The tokens live here,
 * in memory: forgotten on leaving the hubby, after a while without activity in it, when they run
 * out, and whenever the server says the hubby is locked (a 423).
 */

export const UNLOCK_HEADER = 'X-Hub-Unlock'

const tokens = new Map<string, { token: string, expires: number }>()
const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
	revision++
	for (const cb of listeners) cb()
}

/**
 * The hubby an API path belongs to, null for the service's (/api/hub/…): its data
 * (/api/data/<hubby>/…), or a capability only it uses (/api/cap/<capability>/…, as it declares).
 */
export function hubbyOfPath(path: string): string | null {
	const data = /^\/api\/data\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	if (data) return data[1]
	const capability = /^\/api\/cap\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	return capability ? hubbyOfCapability(capability[1]) : null
}

/** The headers unlocking the hubby a call goes to, if it is unlocked here. */
export function unlockHeaders(path: string): Record<string, string> {
	const hubby = hubbyOfPath(path)
	return hubby ? unlockHeadersOf(hubby) : {}
}

/** The headers unlocking a hubby, if it is unlocked here. */
export function unlockHeadersOf(hubby: string): Record<string, string> {
	const unlocked = tokens.get(hubby)
	if (!unlocked) return {}
	if (unlocked.expires <= Date.now()) {
		lock(hubby)
		return {}
	}
	return { [UNLOCK_HEADER]: unlocked.token }
}

/** A 423: the hubby is locked (again) for the server. */
export function lockedByServer(path: string): void {
	const hubby = hubbyOfPath(path)
	if (hubby && tokens.has(hubby)) lock(hubby)
}

export function isUnlocked(hubby: string): boolean {
	const unlocked = tokens.get(hubby)
	return !!unlocked && unlocked.expires > Date.now()
}

/** When a hubby's unlock runs out (ms since the epoch), null: not unlocked. */
export function unlockExpiry(hubby: string): number | null {
	return tokens.get(hubby)?.expires ?? null
}

export function setUnlocked(hubby: string, token: string, expiresIn: number): void {
	tokens.set(hubby, { token, expires: Date.now() + expiresIn * 1000 - 5000 })
	changed()
}

export function lock(hubby: string): void {
	if (tokens.delete(hubby)) changed()
}

/** Re-renders when a hubby is unlocked or locked again. */
export function useLocks(): number {
	return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => revision)
}
