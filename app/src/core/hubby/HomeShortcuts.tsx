import { useEffect } from 'react'
import { platform } from '@platform'
import { useHubbies } from '@core/contexts/HubbiesContext'
import { isInstalled } from './registry'
import { homeShortcutOf } from './homeShortcuts'

/**
 * The hubbies' home screen icons kept in step with the hubbies here (docs/plan-raccourcis.md): one
 * no longer here (uninstalled, hidden) greyed by the launcher, one back enabled, their labels and
 * icons up to date.
 */
export function HomeShortcuts() {
	const hubbies = useHubbies()
	const here = hubbies.filter(isInstalled)
	const key = here.map(m => `${m.id}:${m.label}`).join(',')

	useEffect(() => {
		if (!platform.shortcuts) return
		void platform.shortcuts.sync(here.map(homeShortcutOf)).catch(err => console.warn('[shortcuts] sync failed', err))
	}, [key])

	return null
}
