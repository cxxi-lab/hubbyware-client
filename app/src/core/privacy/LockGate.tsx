import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, errorMessage } from '@core/api/client'
import { isUnlocked, lock, setUnlocked, useLocks } from '@core/privacy/locks'
import { Button, CodeInput } from '@cxxi-lab/hubbyware-ui'

/** without activity in an unlocked hubby for this long, it locks again */
const IDLE_MS = 10 * 60_000
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

/**
 * A hubby locked by a password of its own (Privacy): its pages show only once it is given (the
 * server answers its API only then). Leaving the hubby locks it again, its pages and their data
 * gone; so does a while without activity in it, or the server's word (the unlock ran out).
 */
export function LockGate({ hubby, label, active, pin = false, children }: { hubby: string, label: string, active: boolean, pin?: boolean, children: ReactNode }) {
	useLocks()
	const unlocked = isUnlocked(hubby)

	// leaving it locks it, and so does its disappearing (hidden again, uninstalled)
	useEffect(() => {
		if (!active) lock(hubby)
	}, [active, hubby])
	useEffect(() => () => lock(hubby), [hubby])

	// idle in it
	useEffect(() => {
		if (!active || !unlocked) return
		let timer = setTimeout(() => lock(hubby), IDLE_MS)
		const reset = () => {
			clearTimeout(timer)
			timer = setTimeout(() => lock(hubby), IDLE_MS)
		}
		for (const e of ACTIVITY) window.addEventListener(e, reset, { passive: true })
		return () => {
			clearTimeout(timer)
			for (const e of ACTIVITY) window.removeEventListener(e, reset)
		}
	}, [active, unlocked, hubby])

	if (unlocked) return <>{children}</>
	return active ? <UnlockScreen hubby={hubby} label={label} pin={pin} /> : null
}

/** a PIN's length (the server's HubbyPrivacyKinds::PIN_DIGITS) */
const PIN_DIGITS = 6

function UnlockScreen({ hubby, label, pin }: { hubby: string, label: string, pin: boolean }) {
	const [password, setPassword] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (secret = password) => {
		setBusy(true)
		setError(null)
		try {
			const { data } = await api<{ data: { token: string, expiresIn: number } }>(`/api/hub/privacy/${hubby}/unlock`, { method: 'POST', body: JSON.stringify({ password: secret }) })
			setUnlocked(hubby, data.token, data.expiresIn)
		}
		catch (err) {
			setError(err instanceof ApiError && err.status === 403 ? (pin ? 'Wrong PIN' : 'Wrong password') : err instanceof ApiError && err.status === 429 ? 'Too many tries: wait a few minutes' : errorMessage(err))
			setPassword('')
		}
		finally {
			setBusy(false)
		}
	}

	return (
		<div className="absolute inset-0 z-20 flex items-center justify-center bg-steel-950">
			<form
				className="w-96 max-w-[calc(100vw-2rem)] flex flex-col gap-3 p-6 bg-steel-900 border border-steel-700 rounded-md"
				onSubmit={e => { e.preventDefault(); if (password && !busy) void submit() }}
			>
				<h2 className="m-0 text-sm font-semibold text-white uppercase tracking-wider">{label} is locked</h2>
				<p className="m-0 text-xs text-steel-300">{pin ? 'Its PIN, to open it.' : 'Its password, to open it.'}</p>
				{pin ? (
					// the last digit opens it (no button to reach for)
					<div className="flex justify-center py-1">
						<CodeInput
							label={`${label}'s PIN`}
							length={PIN_DIGITS}
							masked
							autoFocus
							value={password}
							onChange={v => { setPassword(v); if (error) setError(null) }}
							onComplete={v => { if (!busy) void submit(v) }}
							isDisabled={busy}
							isInvalid={error !== null}
						/>
					</div>
				) : (
					<input
						type="password"
						value={password}
						onChange={e => setPassword(e.target.value)}
						autoFocus
						autoComplete="off"
						className="w-full h-9 px-3 text-sm text-white bg-steel-950 border border-steel-700 rounded outline-none focus:border-primary-500"
					/>
				)}
				{error && <p className="m-0 text-xs text-red-300">{error}</p>}
				{!pin && <Button type="submit" label="Unlock" isLoading={busy} isDisabled={!password} className="w-full" />}
			</form>
		</div>
	)
}
