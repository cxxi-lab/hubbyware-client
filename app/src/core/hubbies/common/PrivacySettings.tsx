import { useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '@core/api/client'
import { announceHubbiesChange, fetchHubbiesState } from '@core/api/hubbies'
import type { HubbyManifest } from '@core/hubby/types'
import { useRevealedHubbies } from '@core/privacy/hidden'
import { platform } from '@platform'
import { Button, ChoiceSwitch, CodeInput, Switch, Modal } from '@cxxi-lab/hubbyware-ui'

interface Privacy {
	hidden: boolean
	shortcut: boolean
	locked: boolean
	/** what its lock is: a password, or a PIN (6 digits, on a keypad) */
	lock?: LockKind | null
	blur: boolean
}

type LockKind = 'password' | 'pin'
/** a PIN's length (the server's HubbyPrivacyKinds::PIN_DIGITS) */
const PIN_DIGITS = 6

const NONE: Privacy = { hidden: false, shortcut: false, locked: false, blur: false }

type Action =
	| { kind: 'show' }
	| { kind: 'set' }
	| { kind: 'remove' }
	| { kind: 'unhide' }
	| { kind: 'lock' }
	| { kind: 'unlock' }

const INPUT = 'w-full h-9 px-3 text-sm text-white bg-steel-950 border border-steel-700 rounded outline-none focus:border-primary-500'

/**
 * A hubby's privacy (its settings' common part, every hubby): hidden behind a reveal shortcut, a
 * sequence of keys typed with Ctrl+Alt held (or /reveal on the phone). Hidden, it shows nowhere
 * until its shortcut, and again after Ctrl+Alt+Q or a restart. Seeing, setting or removing the
 * shortcut, and showing the hubby for good, take the account's password; the shortcut itself only
 * lives on the server. Locked by a password of its own, it asks for it each time it is opened (its
 * API waits for it); locking, changing or removing it takes the account's password too.
 */
export function PrivacySettings({ hubby: m }: { hubby: HubbyManifest }) {
	const [privacy, setPrivacy] = useState<Privacy | null>(null)
	const [action, setAction] = useState<Action | null>(null)
	const [shown, setShown] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const revealed = useRevealedHubbies()

	const apply = (all: Record<string, Privacy>) => {
		setPrivacy(all[m.id] ?? NONE)
		// the app hides or shows it at once
		void fetchHubbiesState().then(announceHubbiesChange).catch(() => {})
	}

	useEffect(() => {
		api<{ data: Record<string, Privacy> }>('/api/hub/privacy')
			.then(res => setPrivacy(res.data[m.id] ?? NONE))
			.catch(() => setError('Failed to load'))
	}, [m.id])

	const blur = async (next: boolean) => {
		setError(null)
		try {
			const res = await api<{ data: Record<string, Privacy> }>(`/api/hub/privacy/${m.id}`, { method: 'PATCH', body: JSON.stringify({ blur: next }) })
			apply(res.data)
		}
		catch (err) {
			setError(errorMessage(err))
		}
	}

	const hide = async () => {
		setError(null)
		try {
			const res = await api<{ data: Record<string, Privacy> }>(`/api/hub/privacy/${m.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) })
			// still shown this session: hidden from the next restart, or Ctrl+Alt+Q
			platform.setRevealedHubbies([...revealed, m.id])
			apply(res.data)
		}
		catch (err) {
			setError(errorMessage(err))
		}
	}

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
			<div>
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Privacy</h2>
				<p className="m-0 text-xs text-steel-300">
					Hide {m.label} behind a shortcut: hold Ctrl+Alt and type its keys to reveal it (on the phone: /reveal and its keys).
					Ctrl+Alt+Q hides it again, and so does a restart. Or lock it: its own password, asked each time it is opened.
				</p>
				{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
			</div>

			{privacy && (
				<>
					<div className="flex items-center gap-3">
						<div className="flex-1 min-w-0">
							<div className="text-sm text-white">Reveal shortcut</div>
							<div className="text-xs text-steel-300 font-mono">
								{shown ? `Ctrl+Alt + ${shown.toUpperCase().split('').join(' ')}` : privacy.shortcut ? 'Set (hidden)' : 'None'}
							</div>
						</div>
						{privacy.shortcut ? (
							<>
								{!shown && <Button label="Show" color="secondary" onClick={() => setAction({ kind: 'show' })} />}
								<Button label="Change" color="secondary" onClick={() => setAction({ kind: 'set' })} />
								<Button label="Remove" color="danger" onClick={() => setAction({ kind: 'remove' })} />
							</>
						) : (
							<Button label="Set a shortcut" onClick={() => setAction({ kind: 'set' })} />
						)}
					</div>

					{m.supports?.includes('amounts') && (
						<div className="flex items-center gap-3">
							<div className="flex-1 min-w-0">
								<div className="text-sm text-white">Blur amounts</div>
								<div className="text-xs text-steel-300">Its amounts blurred; a click shows one, until clicked again or Ctrl+Alt+Q.</div>
							</div>
							<Switch checked={privacy.blur} onChange={next => void blur(next)} title={privacy.blur ? 'Show the amounts' : 'Blur the amounts'} />
						</div>
					)}

					<div className="flex items-center gap-3">
						<div className="flex-1 min-w-0">
							<div className="text-sm text-white">Lock</div>
							<div className="text-xs text-steel-300">
								{privacy.locked
									? privacy.lock === 'pin' ? 'Its PIN is asked each time it is opened.' : 'Its own password is asked each time it is opened.'
									: 'Ask a password or a PIN of its own each time it is opened.'}
							</div>
						</div>
						{privacy.locked ? (
							<>
								<Button label="Change" color="secondary" onClick={() => setAction({ kind: 'lock' })} />
								<Button label="Remove" color="danger" onClick={() => setAction({ kind: 'unlock' })} />
							</>
						) : (
							<Button label="Lock it" onClick={() => setAction({ kind: 'lock' })} />
						)}
					</div>

					<div className="flex items-center gap-3">
						<div className="flex-1 min-w-0">
							<div className="text-sm text-white">Hidden</div>
							<div className="text-xs text-steel-300">
								{privacy.shortcut ? 'Shown nowhere until its shortcut reveals it.' : 'Set a shortcut first: it is the only way to reveal it.'}
							</div>
						</div>
						{privacy.shortcut && (
							<Switch
								checked={privacy.hidden}
								onChange={next => { if (next) void hide(); else setAction({ kind: 'unhide' }) }}
								title={privacy.hidden ? 'Show it for good' : 'Hide it'}
							/>
						)}
					</div>
				</>
			)}

			{action && (
				<PasswordModal
					hubby={m}
					action={action}
					privacyLock={privacy?.lock ?? null}
					onClose={() => setAction(null)}
					onDone={(all, shortcut) => {
						setAction(null)
						if (shortcut !== undefined) setShown(shortcut)
						else if (action.kind !== 'show') setShown(null)
						if (all) apply(all)
					}}
				/>
			)}
		</section>
	)
}

const TITLES: Record<Action['kind'], string> = {
	show: 'Show the shortcut',
	set: 'Set the shortcut',
	remove: 'Remove the shortcut',
	unhide: 'Show the hubby for good',
	lock: 'Lock the hubby',
	unlock: 'Remove the lock'
}

/** Asks the account's password (and the new shortcut), then does the action. */
function PasswordModal({ hubby: m, action, privacyLock, onClose, onDone }: {
	hubby: HubbyManifest
	action: Action
	/** the lock it has now (its removal says which) */
	privacyLock: LockKind | null
	onClose: () => void
	onDone: (all: Record<string, Privacy> | null, shortcut?: string) => void
}) {
	const [password, setPassword] = useState('')
	const [shortcut, setShortcut] = useState('')
	const [lockPassword, setLockPassword] = useState('')
	const [lockAgain, setLockAgain] = useState('')
	const [lockKind, setLockKind] = useState<LockKind>('password')
	const pickKind = (kind: LockKind) => { setLockKind(kind); setLockPassword(''); setLockAgain('') }
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async () => {
		setBusy(true)
		setError(null)
		try {
			const base = `/api/hub/privacy/${m.id}`
			if (action.kind === 'show') {
				const res = await api<{ data: { shortcut: string | null } }>(`${base}/shortcut/show`, { method: 'POST', body: JSON.stringify({ password }) })
				onDone(null, res.data.shortcut ?? '')
			}
			else if (action.kind === 'set') {
				const res = await api<{ data: Record<string, Privacy> }>(`${base}/shortcut`, { method: 'PUT', body: JSON.stringify({ password, shortcut }) })
				onDone(res.data)
			}
			else if (action.kind === 'lock') {
				const res = await api<{ data: Record<string, Privacy> }>(`${base}/lock`, { method: 'PUT', body: JSON.stringify({ password, lock: lockPassword, kind: lockKind }) })
				onDone(res.data)
			}
			else if (action.kind === 'unlock') {
				const res = await api<{ data: Record<string, Privacy> }>(`${base}/lock`, { method: 'DELETE', body: JSON.stringify({ password }) })
				onDone(res.data)
			}
			else if (action.kind === 'remove') {
				const res = await api<{ data: Record<string, Privacy> }>(`${base}/shortcut`, { method: 'DELETE', body: JSON.stringify({ password }) })
				onDone(res.data)
			}
			else {
				const res = await api<{ data: Record<string, Privacy> }>(base, { method: 'PATCH', body: JSON.stringify({ hidden: false, password }) })
				onDone(res.data)
			}
		}
		catch (err) {
			setError(err instanceof ApiError && err.status === 403 ? 'Wrong password' : errorMessage(err))
		}
		finally {
			setBusy(false)
		}
	}

	const ready = password !== ''
		&& (action.kind !== 'set' || /^[a-pr-z0-9]{3,16}$/i.test(shortcut))
		&& (action.kind !== 'lock' || (lockPassword === lockAgain && (lockKind === 'pin' ? new RegExp(`^\\d{${PIN_DIGITS}}$`).test(lockPassword) : lockPassword.length >= 4)))

	return (
		<Modal title={TITLES[action.kind]} size="sm" onClose={onClose}>
			<form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (ready && !busy) void submit() }}>
				{action.kind === 'set' && (
					<label className="flex flex-col gap-1 text-xs text-steel-300">
						Keys typed with Ctrl+Alt held (3 to 16 letters or digits, no Q)
						<input value={shortcut} onChange={e => setShortcut(e.target.value.toLowerCase())} autoFocus autoComplete="off" className={`${INPUT} font-mono tracking-widest`} />
					</label>
				)}
				{action.kind === 'lock' && (
					<>
						<div className="flex">
							<ChoiceSwitch
								label="Lock with"
								value={lockKind}
								options={[{ value: 'password', label: 'Password' }, { value: 'pin', label: 'PIN' }]}
								onChange={pickKind}
							/>
						</div>
						{lockKind === 'password' ? (
							<>
								<label className="flex flex-col gap-1 text-xs text-steel-300">
									{m.label}'s own password (4 characters at least)
									<input type="password" value={lockPassword} onChange={e => setLockPassword(e.target.value)} autoFocus autoComplete="new-password" className={INPUT} />
								</label>
								<label className="flex flex-col gap-1 text-xs text-steel-300">
									Again
									<input type="password" value={lockAgain} onChange={e => setLockAgain(e.target.value)} autoComplete="new-password" className={INPUT} />
								</label>
							</>
						) : (
							<>
								<div className="flex flex-col gap-1 text-xs text-steel-300">
									{m.label}'s PIN ({PIN_DIGITS} digits)
									<CodeInput key="pin" label={`${m.label}'s PIN`} length={PIN_DIGITS} masked autoFocus value={lockPassword} onChange={setLockPassword} />
								</div>
								<div className="flex flex-col gap-1 text-xs text-steel-300">
									Again
									<CodeInput key="again" label={`${m.label}'s PIN, again`} length={PIN_DIGITS} masked value={lockAgain} onChange={setLockAgain}
										isInvalid={lockAgain.length === PIN_DIGITS && lockAgain !== lockPassword} />
								</div>
							</>
						)}
					</>
				)}
				{action.kind === 'unlock' && <p className="m-0 text-xs text-steel-300">{m.label} will open without its {privacyLock === 'pin' ? 'PIN' : 'password'}.</p>}
				{action.kind === 'remove' && <p className="m-0 text-xs text-steel-300">{m.label} will show again, everywhere.</p>}
				{action.kind === 'unhide' && <p className="m-0 text-xs text-steel-300">{m.label} will show everywhere, without its shortcut.</p>}
				<label className="flex flex-col gap-1 text-xs text-steel-300">
					Your account's password
					<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus={action.kind !== 'set' && action.kind !== 'lock'} autoComplete="current-password" className={INPUT} />
				</label>
				{error && <p className="m-0 text-xs text-red-300">{error}</p>}
				<div className="flex justify-end gap-2">
					<Button label="Cancel" color="secondary" onClick={onClose} />
					<Button type="submit" label="Confirm" color={action.kind === 'remove' || action.kind === 'unlock' ? 'danger' : 'primary'} isDisabled={!ready} isLoading={busy} />
				</div>
			</form>
		</Modal>
	)
}
