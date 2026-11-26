import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { HomeShortcut } from '@platform/types'
import type { HubbyManifest } from './types'

/** an adaptive icon's full square (108 dp at xxxhdpi) */
const SIZE = 432
/** the glyph's box: inside the launchers' masks (their safe zone is the middle 66 dp of 108) */
const GLYPH = SIZE * 0.36

/** The app's colours for a hubby's tile (primary-500 behind, steel-800 glyph), read from its theme. */
function tileColours(): { back: string, glyph: string } {
	const probe = document.createElement('span')
	probe.className = 'bg-primary-500 text-steel-800'
	probe.style.display = 'none'
	document.body.appendChild(probe)
	const style = getComputedStyle(probe)
	const colours = { back: style.backgroundColor || '#4a8ff7', glyph: style.color || '#1e2025' }
	probe.remove()
	return colours
}

/** The hubby's icon as the app shows it (its glyph on the brand colour), a PNG data: URL; null: none. */
export function hubbyIconPng(icon: IconDefinition | undefined): string | null {
	if (!icon) return null
	const [width, height, , , path] = icon.icon
	const canvas = document.createElement('canvas')
	canvas.width = canvas.height = SIZE
	const ctx = canvas.getContext('2d')
	if (!ctx) return null
	const { back, glyph } = tileColours()
	ctx.fillStyle = back
	ctx.fillRect(0, 0, SIZE, SIZE)
	const scale = GLYPH / Math.max(width, height)
	ctx.translate((SIZE - width * scale) / 2, (SIZE - height * scale) / 2)
	ctx.scale(scale, scale)
	ctx.fillStyle = glyph
	for (const d of Array.isArray(path) ? path : [path]) ctx.fill(new Path2D(d))
	return canvas.toDataURL('image/png')
}

/** A hubby's home screen shortcut: its label and its icon. */
export function homeShortcutOf(m: HubbyManifest): HomeShortcut {
	return { hubby: m.id, label: m.label, icon: hubbyIconPng(m.icon) }
}
