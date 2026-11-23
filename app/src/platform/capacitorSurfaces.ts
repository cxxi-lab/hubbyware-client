import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type { NativeSurfacesApi } from './types'

/** The Surfaces plugin (Android: SurfacesPlugin.java): a hubby's web surfaces as native WebViews. */
interface SurfacesPlugin {
	show(o: { id: number, x: number, y: number, width: number, height: number, visible: boolean, src: string, referrer: string | null, userAgent: string | null }): Promise<void>
	close(o: { id: number }): Promise<void>
	exec(o: { id: number, code: string }): Promise<{ result: string | null }>
	reload(o: { id: number }): Promise<void>
	back(o: { id: number }): Promise<void>
	forward(o: { id: number }): Promise<void>
	load(o: { id: number, url: string }): Promise<void>
	addListener(event: 'event', cb: (e: { id: number, event: string, detail: Record<string, unknown> }) => void): Promise<PluginListenerHandle>
}

const Surfaces = registerPlugin<SurfacesPlugin>('Surfaces')

export function createNativeSurfaces(): NativeSurfacesApi {
	return {
		show: surface => Surfaces.show(surface),
		close: id => Surfaces.close({ id }),
		// its value comes back as JSON (evaluateJavascript's)
		exec: async (id, code) => {
			const { result } = await Surfaces.exec({ id, code })
			if (result === null || result === undefined || result === 'null') return null
			try { return JSON.parse(result) as unknown }
			catch { return result }
		},
		reload: id => Surfaces.reload({ id }),
		back: id => Surfaces.back({ id }),
		forward: id => Surfaces.forward({ id }),
		load: (id, url) => Surfaces.load({ id, url }),
		onEvent(cb) {
			const handle = Surfaces.addListener('event', cb)
			return () => { void handle.then(h => h.remove()) }
		}
	}
}
