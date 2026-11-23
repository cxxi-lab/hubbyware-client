export interface UserMenuProps {
	/** the hubby open (its settings first in the menu), null: none */
	hubby?: { label: string, onSettings: () => void } | null
	onHubbies?: () => void
	onDevices?: () => void
	onSettings?: () => void
	onLogout?: () => void | Promise<void>
}
