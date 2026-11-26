import { useEffect, useState } from 'react'
import { faMobileScreen } from '@fortawesome/free-solid-svg-icons'
import { Button } from '@cxxi-lab/hubbyware-ui'
import { platform } from '@platform'
import type { HubbyManifest } from '@core/hubby/types'
import { homeShortcutOf } from '@core/hubby/homeShortcuts'

/**
 * A hubby's own icon on the phone's home screen (docs/plan-raccourcis.md): it opens the app on
 * it. Shown where the launcher takes shortcuts (Android).
 */
export function HomeScreenSettings({ hubby: m }: { hubby: HubbyManifest }) {
	const shortcuts = platform.shortcuts
	const [supported, setSupported] = useState(false)
	const [state, setState] = useState<'idle' | 'asked' | 'failed'>('idle')

	useEffect(() => {
		let live = true
		void shortcuts?.supported().then(s => { if (live) setSupported(s) })
		return () => { live = false }
	}, [shortcuts])

	if (!shortcuts || !supported) return null

	async function add() {
		try {
			setState(await shortcuts!.pin(homeShortcutOf(m)) ? 'asked' : 'failed')
		}
		catch (err) {
			console.warn('[shortcuts] pin failed', err)
			setState('failed')
		}
	}

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col sm:flex-row sm:items-center gap-4">
			<div className="flex-1 min-w-0">
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Home screen</h2>
				<p className="m-0 text-xs text-steel-300">
					{state === 'failed'
						? 'Your launcher did not take the icon.'
						: `Put a ${m.label} icon on your phone's home screen: it opens Hubbyware straight on ${m.label}.`}
				</p>
			</div>
			<Button icon={faMobileScreen} label="Add to home screen" onClick={() => void add()} />
		</section>
	)
}
