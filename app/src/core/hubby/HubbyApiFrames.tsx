import { useEffect, useSyncExternalStore } from 'react'
import { platform } from '@platform'
import { useHubbies } from '@core/contexts/HubbiesContext'
import { hasScope, useHubbyScopes } from '@core/hubbies/scopes'
import { headlessFrames, setBackgroundHubbies } from './apis'
import { isInstalled } from './registry'
import { HubbyHost } from './HubbyHost'

/**
 * The unseen frames of the hubbies: answering their API's calls (apis.ts), and those working in the
 * background (hubby.json `background`, scope app:background granted, a desktop: docs/plan-auto-desktop.md D1).
 */
export function HubbyApiFrames() {
	const hubbies = useHubbies()
	const scopes = useHubbyScopes()
	const working = platform.capabilities.background
		? hubbies.filter(m => m.background && isInstalled(m) && hasScope(scopes, m.id, 'app:background')).map(m => m.id)
		: []
	const key = working.join(',')
	useEffect(() => { setBackgroundHubbies(key ? key.split(',') : []) }, [key])
	const ids = useSyncExternalStore(headlessFrames.subscribe, headlessFrames.current)
	return <>{ids.map(id => <HubbyHost key={id} hubby={id} headless background={headlessFrames.isBackground(id)} />)}</>
}
